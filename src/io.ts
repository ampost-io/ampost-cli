import type { Io } from "./cli.js";

/** The real terminal. */
export function nodeIo(): Io {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin,
    promptSecret,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads one line from the terminal without echoing it. Ctrl+C cancels. */
function promptSecret(question: string): Promise<string> {
  const { stdin, stderr } = process;
  stderr.write(question);
  return new Promise((resolve, reject) => {
    let answer = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      if (error) reject(error);
      else resolve(answer);
    };
    const onData = (data: string) => {
      for (const char of data) {
        if (char === "\r" || char === "\n" || char === "\u0004") return done();
        if (char === "\u0003") return done(new Error("Cancelled"));
        if (char === "\u007f" || char === "\b") answer = answer.slice(0, -1);
        else if (char >= " ") answer += char;
      }
    };
    stdin.on("data", onData);
  });
}
