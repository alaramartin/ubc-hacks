// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IUSDC {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

interface IHalo2Verifier {
    function verifyProof(bytes calldata proof, uint256[] calldata instances) external returns (bool);
}

/// @title ReceiptEscrow
/// @notice Escrow for paid model inference where the seller proves, with an EZKL proof, that its
/// committed model produced the answer from the buyer's input. Payment settles optimistically:
/// the seller is paid after a challenge window unless someone shows the proof is invalid, in which
/// case the buyer is refunded and part of the seller's bond goes to the challenger.
///
/// Proof instances are laid out as [commitment, input[0..n), output[0..m)] (see spec/instances.md).
/// The verifier is shared per model architecture: its verifying key does not depend on the weights,
/// so a seller's model is identified only by its commitment (the Poseidon hash of its weights).
contract ReceiptEscrow {
    enum Status {
        None,
        Open,
        Fulfilled,
        Finalized,
        Slashed,
        Refunded
    }

    struct Seller {
        uint256 commitment;
        uint256 price;
        uint256 bond;
        bool slashed;
        bool registered;
        string endpoint;
    }

    struct Job {
        address buyer;
        address seller;
        uint256 commitment;
        uint256 price;
        bytes32 inputHash;
        bytes32 proofHash;
        uint64 deadline;
        uint64 fulfilledAt;
        Status status;
        uint256[] output;
    }

    /// @notice A buyer's signed EIP-3009 ReceiveWithAuthorization (to = this contract, nonce = jobNonce).
    struct Authorization {
        address from;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    IUSDC public immutable usdc;
    IHalo2Verifier public immutable verifier;
    uint256 public immutable nInputs;
    uint256 public immutable nOutputs;
    uint256 public immutable minBond;
    uint256 public immutable slashAmount;
    uint64 public immutable challengeWindow;
    /// @notice Gas forwarded to the verifier in a challenge. Fixed so a challenger cannot starve the
    /// call and make a valid proof look invalid.
    uint256 public immutable verifyGas;

    mapping(address => Seller) public sellers;
    address[] public sellerList;
    mapping(bytes32 => Job) internal jobs;

    event SellerRegistered(address indexed seller, uint256 commitment, uint256 price, uint256 bond, string endpoint);
    event SellerUpdated(address indexed seller, uint256 price, uint256 bond, string endpoint);
    event JobOpened(
        bytes32 indexed jobId,
        address indexed buyer,
        address indexed seller,
        uint256 commitment,
        uint256 price,
        bytes32 inputHash,
        uint64 deadline
    );
    event JobFulfilled(bytes32 indexed jobId, uint256[] input, uint256[] output, bytes proof, uint64 challengeEndsAt);
    event JobFinalized(bytes32 indexed jobId, address indexed seller, uint256 paid);
    event JobRefunded(bytes32 indexed jobId, address indexed buyer, uint256 refunded);
    event JobSlashed(
        bytes32 indexed jobId,
        address indexed seller,
        address indexed challenger,
        uint256 refunded,
        uint256 slashed
    );

    error NotRegistered();
    error AlreadyRegistered();
    error SellerSlashed();
    error BondTooLow();
    error WrongPrice();
    error JobExists();
    error BadStatus(Status status);
    error NotSeller();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error WindowOpen();
    error WindowClosed();
    error WrongLength();
    error InputMismatch();
    error ProofMismatch();
    error ProofValid();
    error TransferFailed();
    error NotEnoughGas();

    constructor(
        IUSDC usdc_,
        IHalo2Verifier verifier_,
        uint256 nInputs_,
        uint256 nOutputs_,
        uint256 minBond_,
        uint256 slashAmount_,
        uint64 challengeWindow_,
        uint256 verifyGas_
    ) {
        usdc = usdc_;
        verifier = verifier_;
        nInputs = nInputs_;
        nOutputs = nOutputs_;
        minBond = minBond_;
        slashAmount = slashAmount_;
        challengeWindow = challengeWindow_;
        verifyGas = verifyGas_;
    }

    // ---------------------------------------------------------------- sellers

    /// @notice Register as a seller. Pulls `bond` USDC from the caller (approve first).
    function registerSeller(uint256 commitment, uint256 price, uint256 bond, string calldata endpoint) external {
        Seller storage s = sellers[msg.sender];
        if (s.registered) revert AlreadyRegistered();
        if (bond < minBond) revert BondTooLow();
        _pull(msg.sender, bond);
        sellers[msg.sender] =
            Seller({commitment: commitment, price: price, bond: bond, slashed: false, registered: true, endpoint: endpoint});
        sellerList.push(msg.sender);
        emit SellerRegistered(msg.sender, commitment, price, bond, endpoint);
    }

    /// @notice Change price or endpoint, or add to the bond. The commitment cannot change: a new
    /// model needs a new seller address, so buyers can track each model's history.
    function updateSeller(uint256 price, uint256 addBond, string calldata endpoint) external {
        Seller storage s = sellers[msg.sender];
        if (!s.registered) revert NotRegistered();
        if (s.slashed) revert SellerSlashed();
        if (addBond > 0) {
            _pull(msg.sender, addBond);
            s.bond += addBond;
        }
        s.price = price;
        s.endpoint = endpoint;
        emit SellerUpdated(msg.sender, price, s.bond, endpoint);
    }

    function sellerCount() external view returns (uint256) {
        return sellerList.length;
    }

    // ---------------------------------------------------------------- jobs

    /// @notice The EIP-3009 nonce a buyer signs. It binds the payment to one seller, input and deadline,
    /// so whoever submits the authorization cannot change the job's terms.
    function jobNonce(address seller, bytes32 inputHash, uint64 deadline) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), seller, inputHash, deadline));
    }

    function inputHashOf(uint256[] calldata input) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(input));
    }

    /// @notice Open a job with the buyer's signed USDC ReceiveWithAuthorization. Anyone may submit it;
    /// in practice the seller does, as the x402 resource server.
    function open(address seller, bytes32 inputHash, uint64 deadline, Authorization calldata auth)
        external
        returns (bytes32 jobId)
    {
        Seller storage sel = sellers[seller];
        if (!sel.registered) revert NotRegistered();
        if (sel.slashed) revert SellerSlashed();
        if (auth.value != sel.price) revert WrongPrice();
        if (deadline <= block.timestamp) revert DeadlinePassed();

        jobId = jobNonce(seller, inputHash, deadline);
        Job storage j = jobs[jobId];
        if (j.status != Status.None) revert JobExists();

        usdc.receiveWithAuthorization(
            auth.from, address(this), auth.value, auth.validAfter, auth.validBefore, jobId, auth.v, auth.r, auth.s
        );

        j.buyer = auth.from;
        j.seller = seller;
        j.commitment = sel.commitment;
        j.price = auth.value;
        j.inputHash = inputHash;
        j.deadline = deadline;
        j.status = Status.Open;
        emit JobOpened(jobId, auth.from, seller, sel.commitment, auth.value, inputHash, deadline);
    }

    /// @notice Seller posts its answer and proof, with the buyer's input. Input, output and proof go
    /// in the event so anyone can re-run verification or challenge; only hashes and the output are stored.
    function fulfill(bytes32 jobId, uint256[] calldata input, uint256[] calldata output, bytes calldata proof)
        external
    {
        Job storage j = jobs[jobId];
        if (j.status != Status.Open) revert BadStatus(j.status);
        if (msg.sender != j.seller) revert NotSeller();
        if (block.timestamp > j.deadline) revert DeadlinePassed();
        if (output.length != nOutputs || input.length != nInputs) revert WrongLength();
        if (keccak256(abi.encodePacked(input)) != j.inputHash) revert InputMismatch();
        j.output = output;
        j.proofHash = keccak256(proof);
        j.fulfilledAt = uint64(block.timestamp);
        j.status = Status.Fulfilled;
        emit JobFulfilled(jobId, input, output, proof, uint64(block.timestamp) + challengeWindow);
    }

    /// @notice Pay the seller once the challenge window has passed. Callable by anyone.
    function finalize(bytes32 jobId) external {
        Job storage j = jobs[jobId];
        if (j.status != Status.Fulfilled) revert BadStatus(j.status);
        if (block.timestamp < j.fulfilledAt + challengeWindow) revert WindowOpen();
        j.status = Status.Finalized;
        _send(j.seller, j.price);
        emit JobFinalized(jobId, j.seller, j.price);
    }

    /// @notice Refund the buyer if the seller never fulfilled before the deadline.
    function refund(bytes32 jobId) external {
        Job storage j = jobs[jobId];
        if (j.status != Status.Open) revert BadStatus(j.status);
        if (block.timestamp <= j.deadline) revert DeadlineNotPassed();
        j.status = Status.Refunded;
        _send(j.buyer, j.price);
        emit JobRefunded(jobId, j.buyer, j.price);
    }

    /// @notice Challenge a fulfilled job. The challenger supplies the input preimage and the proof
    /// bytes, both checked against stored hashes; the commitment and output come from storage. If the
    /// proof does not verify against those instances, the buyer is refunded and up to `slashAmount`
    /// of the seller's bond goes to the challenger. If it verifies, the call reverts.
    function challenge(bytes32 jobId, uint256[] calldata input, bytes calldata proof) external {
        Job storage j = jobs[jobId];
        if (j.status != Status.Fulfilled) revert BadStatus(j.status);
        if (block.timestamp >= j.fulfilledAt + challengeWindow) revert WindowClosed();
        if (input.length != nInputs) revert WrongLength();
        if (keccak256(abi.encodePacked(input)) != j.inputHash) revert InputMismatch();
        if (keccak256(proof) != j.proofHash) revert ProofMismatch();

        if (_verifies(proof, instancesOf(j.commitment, input, j.output))) revert ProofValid();

        Seller storage sel = sellers[j.seller];
        uint256 cut = sel.bond < slashAmount ? sel.bond : slashAmount;
        sel.bond -= cut;
        sel.slashed = true;
        j.status = Status.Slashed;
        _send(j.buyer, j.price);
        if (cut > 0) _send(msg.sender, cut);
        emit JobSlashed(jobId, j.seller, msg.sender, j.price, cut);
    }

    /// @notice Instances in EZKL order: [commitment, input..., output...].
    function instancesOf(uint256 commitment, uint256[] calldata input, uint256[] memory output)
        public
        pure
        returns (uint256[] memory inst)
    {
        inst = new uint256[](1 + input.length + output.length);
        inst[0] = commitment;
        for (uint256 i = 0; i < input.length; i++) {
            inst[1 + i] = input[i];
        }
        for (uint256 i = 0; i < output.length; i++) {
            inst[1 + input.length + i] = output[i];
        }
    }

    function getJob(bytes32 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    // ---------------------------------------------------------------- internal

    /// @dev The EZKL verifier reverts or returns false on a bad proof; both count as "does not verify".
    function _verifies(bytes calldata proof, uint256[] memory inst) internal returns (bool) {
        if (gasleft() < verifyGas + verifyGas / 63 + 50_000) revert NotEnoughGas();
        (bool ok, bytes memory ret) = address(verifier).call{gas: verifyGas}(abi.encodeCall(IHalo2Verifier.verifyProof, (proof, inst)));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }

    function _pull(address from, uint256 amount) internal {
        if (!usdc.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _send(address to, uint256 amount) internal {
        if (!usdc.transfer(to, amount)) revert TransferFailed();
    }
}
