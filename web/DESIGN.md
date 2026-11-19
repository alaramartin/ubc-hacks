# Receipt pages: design direction

The page is a test certificate for one paid model answer, closer to a lab assay slip than to a web app. Someone opens it from a terminal link or a judge's phone and needs to see, in order: what was asked, what the model said, whether the proof holds, and where the money went.

## Palette

| Name | Hex | Role |
|---|---|---|
| slip | `#E9EEEA` | page ground, the grey-green of carbonless form paper |
| sheet | `#F7F9F6` | the certificate surface |
| ink | `#17201C` | text |
| rule | `#B8C3BC` | table rules and the sheet edge |
| faint | `#55625B` | secondary text (passes AA on sheet) |
| pass | `#1E6A4C` | verified stamp, finalized |
| fail | `#A8231C` | slashed stamp, failed verification |

Dark mode swaps slip/sheet/ink for `#121815` / `#1B231F` / `#E4EBE6`, with the stamp colours lightened to `#5FB28C` and `#F0857D`.

## Type

IBM Plex Sans for text and IBM Plex Mono for the values that are code: addresses, hashes, field elements. Plex was drawn for engineering documentation, and the mono pairs with it metrically, so hex values line up in tables. Scale: 13 / 15 / 17 / 28 / 56 px.

## Layout

```
slip ground
  ┌ sheet (max 760px, left edge aligned to a 24px gutter on phones) ─────────┐
  │ Honest Model receipt                                   [stamp]          │
  │ risk 0.9993   for 0xab12…ef  at block 73,010,512                         │
  │──────────────────────────────────────────────────────────────────────────│
  │ model     commitment 0x33db…  seller 0x5B95…  price 0.01 USDC            │
  │ input     table: feature | value | field element                         │
  │ output    logit, risk                                                    │
  │ proof     4,416 bytes    [Verify again]  result line                     │
  │ money     timeline: opened, fulfilled, finalized / challenged + slashed  │
  └──────────────────────────────────────────────────────────────────────────┘
```

## Signature detail

The status stamp: a rotated, double-ruled ink stamp (VERIFIED in pass green or SLASHED in fail red) with the settlement time inside, set at the top right of the sheet like a stamp on a paper form.

## Motion

One moment only: when "Verify again" returns, the result stamp sets down with a short scale-and-settle (150 ms), skipped under `prefers-reduced-motion`.
