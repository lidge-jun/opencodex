// Actual owned native fixture; never imports or starts the proxy or an installed Codex.
import { dlopen, ptr } from "bun:ffi";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { queryWindowsFixtureObjectName } from "./windows-cli-child-object-name";

const [mode, path] = process.argv.slice(2);
switch (mode) {
  case "args": process.stdout.write(JSON.stringify(process.argv.slice(3))); break;
  case "env": process.stdout.write(JSON.stringify(process.argv.slice(3).map(key => process.env[key] ?? null))); break;
  case "unicode": {
    const bytes = Buffer.from("한글🙂終");
    for (const byte of bytes) { process.stdout.write(Buffer.from([byte])); await Bun.sleep(2); }
    break;
  }
  case "overflow": {
    const bytes = Buffer.alloc(Number(path), 120);
    await Bun.write(Bun.stdout, bytes);
    if (process.argv[4]) await Bun.sleep(Number(process.argv[4]));
    break;
  }
  case "exit259": {
    const { symbols } = dlopen("kernel32.dll", { ExitProcess: { args: ["u32"], returns: "void" } });
    symbols.ExitProcess!(259); break;
  }
  case "marker": writeFileSync(path!, "user-code-ran"); break;
  case "gate": {
    writeFileSync(`${path}.ready`, "ready");
    const deadline = Date.now() + 15000;
    while (!existsSync(path!) && Date.now() < deadline) await Bun.sleep(5);
    writeFileSync(`${path}.done`, "done"); break;
  }
  case "descendant": {
    // Normal CreateProcess descendants inherit the helper's Job. No Bun runtime
    // subprocess finalizer/Job can alter the lifetime being exercised here.
    const k = dlopen("kernel32.dll", {
      CreateProcessW: { args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
      CloseHandle: { args: ["u64"], returns: "i32" }, ExitProcess: { args: ["u32"], returns: "void" },
    }).symbols;
    const wide = (text: string) => Buffer.from(text + "\0", "utf16le");
    const quote = (arg: string) => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
    const exe = wide(process.execPath), command = wide([process.execPath, import.meta.path, "gate", path!].map(quote).join(" "));
    const startup = Buffer.alloc(104), info = Buffer.alloc(24); startup.writeUInt32LE(104);
    if (!k.CreateProcessW!(ptr(exe), ptr(command), null, null, 0, 0x08000000, null, null, ptr(startup), ptr(info))) throw new Error("fixture descendant spawn");
    writeFileSync(`${path}.primary`, JSON.stringify({ pid: info.readUInt32LE(16) }));
    k.CloseHandle!(info.readBigUInt64LE()); k.CloseHandle!(info.readBigUInt64LE(8));
    k.ExitProcess!(0); break;
  }
  case "audit": {
    const input = JSON.parse(readFileSync(path!, "utf8")) as { own: { handle: string; name: string }[]; foreign: { handle: string; name: string }[] };
    const own = input.own.map(item => queryWindowsFixtureObjectName(BigInt(item.handle)) === item.name);
    const foreign = input.foreign.map(item => queryWindowsFixtureObjectName(BigInt(item.handle)) === item.name);
    const k = dlopen("kernel32.dll", { GetStdHandle: { args: ["i32"], returns: "u64" } });
    const standards = input.own.map((item, index) => BigInt(k.symbols.GetStdHandle!(-10 - index)) === BigInt(item.handle));
    process.stdout.write(JSON.stringify({ own, foreign, standards })); k.close(); break;
  }
  default: throw new Error(`unexpected fixture mode ${mode}`);
}
