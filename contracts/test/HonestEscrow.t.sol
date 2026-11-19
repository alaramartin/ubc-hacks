// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HonestEscrow, IUSDC, IHalo2Verifier} from "../src/HonestEscrow.sol";
import {Halo2Verifier} from "../src/Halo2Verifier.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract HonestEscrowTest is Test {
    MockUSDC usdc;
    Halo2Verifier verifier;
    HonestEscrow escrow;

    uint256 buyerKey = 0xB0B;
    address buyer;
    address seller = makeAddr("seller");
    address watcher = makeAddr("watcher");

    uint256 constant PRICE = 100_000; // 0.10 USDC
    uint256 constant BOND = 10_000_000; // 10 USDC
    uint256 constant SLASH = 5_000_000;
    uint64 constant WINDOW = 60;

    bytes proof;
    uint256 commitment;
    uint256[] input;
    uint256[] output;

    function setUp() public {
        buyer = vm.addr(buyerKey);
        usdc = new MockUSDC();
        verifier = new Halo2Verifier();
        escrow = new HonestEscrow(
            IUSDC(address(usdc)), IHalo2Verifier(address(verifier)), 7, 1, BOND, SLASH, WINDOW, 3_000_000
        );

        string memory j = vm.readFile("test/fixtures/spike.json");
        proof = vm.parseJsonBytes(j, ".proof");
        string[] memory s = vm.parseJsonStringArray(j, ".instances");
        commitment = vm.parseUint(s[0]);
        for (uint256 i = 1; i < 8; i++) input.push(vm.parseUint(s[i]));
        output.push(vm.parseUint(s[8]));

        usdc.mint(buyer, 10_000_000);
        usdc.mint(seller, BOND);
        vm.startPrank(seller);
        usdc.approve(address(escrow), BOND);
        escrow.registerSeller(commitment, PRICE, BOND, "http://seller");
        vm.stopPrank();
    }

    function _auth(bytes32 inputHash, uint64 deadline) internal view returns (HonestEscrow.Authorization memory a) {
        bytes32 nonce = escrow.jobNonce(seller, inputHash, deadline);
        a.from = buyer;
        a.value = PRICE;
        a.validAfter = 0;
        a.validBefore = block.timestamp + 600;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                        buyer,
                        address(escrow),
                        PRICE,
                        a.validAfter,
                        a.validBefore,
                        nonce
                    )
                )
            )
        );
        (a.v, a.r, a.s) = vm.sign(buyerKey, digest);
    }

    function _open(uint256[] memory in_) internal returns (bytes32 jobId) {
        bytes32 h = keccak256(abi.encodePacked(in_));
        uint64 deadline = uint64(block.timestamp + 300);
        jobId = escrow.open(seller, h, deadline, _auth(h, deadline));
    }

    function test_honestFlowFinalizes() public {
        bytes32 id = _open(input);
        assertEq(usdc.balanceOf(address(escrow)), BOND + PRICE);
        vm.prank(seller);
        escrow.fulfill(id, output, proof);

        vm.expectRevert(HonestEscrow.WindowOpen.selector);
        escrow.finalize(id);

        vm.warp(block.timestamp + WINDOW);
        escrow.finalize(id);
        assertEq(usdc.balanceOf(seller), PRICE);
        assertEq(uint8(escrow.getJob(id).status), uint8(HonestEscrow.Status.Finalized));
    }

    function test_challengeOnValidProofReverts() public {
        bytes32 id = _open(input);
        vm.prank(seller);
        escrow.fulfill(id, output, proof);
        vm.prank(watcher);
        vm.expectRevert(HonestEscrow.ProofValid.selector);
        escrow.challenge{gas: 5_000_000}(id, input, proof);
    }

    function test_starvedChallengeCannotSlash() public {
        bytes32 id = _open(input);
        vm.prank(seller);
        escrow.fulfill(id, output, proof);
        vm.prank(watcher);
        vm.expectRevert(HonestEscrow.NotEnoughGas.selector);
        escrow.challenge{gas: 1_500_000}(id, input, proof);
    }

    function test_editedOutputGetsSlashed() public {
        bytes32 id = _open(input);
        uint256[] memory edited = new uint256[](1);
        edited[0] = output[0] - 3000; // a lower risk score than the model produced
        vm.prank(seller);
        escrow.fulfill(id, edited, proof);

        vm.prank(watcher);
        escrow.challenge{gas: 5_000_000}(id, input, proof);
        assertEq(usdc.balanceOf(buyer), 10_000_000);
        assertEq(usdc.balanceOf(watcher), SLASH);
        (,, uint256 bond, bool slashed,,) = escrow.sellers(seller);
        assertEq(bond, BOND - SLASH);
        assertTrue(slashed);
    }

    function test_proofOverOtherInputGetsSlashed() public {
        uint256[] memory realInput = input;
        realInput[4] += 8192; // the buyer's input differs from what the seller proved over
        bytes32 id = _open(realInput);
        vm.prank(seller);
        escrow.fulfill(id, output, proof);
        vm.prank(watcher);
        escrow.challenge{gas: 5_000_000}(id, realInput, proof);
        assertEq(uint8(escrow.getJob(id).status), uint8(HonestEscrow.Status.Slashed));
    }

    function test_otherModelGetsSlashed() public {
        address other = makeAddr("other");
        usdc.mint(other, BOND);
        vm.startPrank(other);
        usdc.approve(address(escrow), BOND);
        escrow.registerSeller(commitment + 1, PRICE, BOND, "http://other");
        vm.stopPrank();

        seller = other;
        bytes32 id = _open(input);
        vm.prank(other);
        escrow.fulfill(id, output, proof);
        escrow.challenge{gas: 5_000_000}(id, input, proof);
        (,,, bool slashed,,) = escrow.sellers(other);
        assertTrue(slashed);
    }

    function test_wrongPreimageRejected() public {
        bytes32 id = _open(input);
        vm.prank(seller);
        escrow.fulfill(id, output, proof);
        uint256[] memory forged = input;
        forged[0] += 1;
        vm.expectRevert(HonestEscrow.InputMismatch.selector);
        escrow.challenge(id, forged, proof);
    }

    function test_wrongProofBytesRejected() public {
        bytes32 id = _open(input);
        vm.prank(seller);
        escrow.fulfill(id, output, proof);
        bytes memory other = bytes.concat(proof, hex"00");
        vm.expectRevert(HonestEscrow.ProofMismatch.selector);
        escrow.challenge(id, input, other);
    }

    function test_challengeAfterWindowRejected() public {
        bytes32 id = _open(input);
        vm.prank(seller);
        escrow.fulfill(id, output, proof);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(HonestEscrow.WindowClosed.selector);
        escrow.challenge(id, input, proof);
    }

    function test_refundWhenNotFulfilled() public {
        bytes32 id = _open(input);
        vm.expectRevert(HonestEscrow.DeadlineNotPassed.selector);
        escrow.refund(id);
        vm.warp(block.timestamp + 301);
        escrow.refund(id);
        assertEq(usdc.balanceOf(buyer), 10_000_000);
    }

    function test_sellerCannotChangeTerms() public {
        bytes32 h = keccak256(abi.encodePacked(input));
        uint64 deadline = uint64(block.timestamp + 300);
        HonestEscrow.Authorization memory a = _auth(h, deadline);
        bytes32 otherHash = keccak256("other input");
        vm.expectRevert(bytes("bad sig"));
        escrow.open(seller, otherHash, deadline, a);
    }

    function test_onlySellerFulfills() public {
        bytes32 id = _open(input);
        vm.expectRevert(HonestEscrow.NotSeller.selector);
        escrow.fulfill(id, output, proof);
    }

    function test_slashedSellerCannotTakeJobs() public {
        test_editedOutputGetsSlashed();
        bytes32 h = keccak256(abi.encodePacked(input));
        uint64 deadline = uint64(block.timestamp + 400);
        HonestEscrow.Authorization memory a = _auth(h, deadline);
        vm.expectRevert(HonestEscrow.SellerSlashed.selector);
        escrow.open(seller, h, deadline, a);
    }
}
