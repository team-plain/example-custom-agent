// Colour is opt-out rather than opt-in: NO_COLOR or a redirected stdout (a log file, a pipe) both
// turn it off, so nothing writes escape codes into something that will never render them.
const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR;

function paint(code: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);

export const ok = (msg: string) => `${green("OK")}   ${msg}`;
export const fail = (msg: string) => `${red("FAIL")} ${msg}`;
export const warn = (msg: string) => `${yellow("warn")} ${msg}`;

/** Missing permissions the agent runs fine without. Dim, because it is not a problem to fix. */
export const opt = (msg: string) => `${dim("opt")}  ${msg}`;

/** Indents under an ok/fail/warn/opt line so the continuation lines up with its text. */
export const note = (msg: string) => dim(`     ${msg}`);

export const label = (text: string) => dim(text.padEnd(15));
export const heading = (text: string) => bold(text);
