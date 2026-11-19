import pc from "picocolors";
import type { Address, Hex } from "viem";
import { txUrl } from "./chain.ts";

const LABEL_W = 12;

export function link(text: string, url: string): string {
  return process.stdout.isTTY ? `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007` : `${text} ${pc.dim(url)}`;
}

export function short(x: string, n = 6): string {
  return x.length <= 2 + n * 2 ? x : `${x.slice(0, 2 + n)}…${x.slice(-4)}`;
}

export function tx(hash: Hex): string {
  return link(pc.underline(short(hash)), txUrl(hash));
}

export function usdc(units: bigint): string {
  const s = (Number(units) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `${s} USDC`;
}

export function title(s: string) {
  console.log(`\n${pc.bold(s)}`);
}

export function step(label: string, msg: string) {
  console.log(`  ${pc.cyan(label.padEnd(LABEL_W))} ${msg}`);
}

export function ok(label: string, msg: string) {
  console.log(`  ${pc.green(label.padEnd(LABEL_W))} ${msg}`);
}

export function bad(label: string, msg: string) {
  console.log(`  ${pc.red(pc.bold(label.padEnd(LABEL_W)))} ${msg}`);
}

export function note(msg: string) {
  console.log(`  ${" ".repeat(LABEL_W)} ${pc.dim(msg)}`);
}

export function decision(good: boolean, msg: string) {
  const tag = good ? pc.bgGreen(pc.black(" PAY ")) : pc.bgRed(pc.white(" REFUSE "));
  console.log(`\n  ${tag} ${pc.bold(msg)}\n`);
}

export function addr(a: Address): string {
  return short(a, 4);
}
