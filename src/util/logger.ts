import { inspect } from "util";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export namespace Logger {
  export type Instance = ReturnType<typeof create>;

  type Sink = (line: string, stream: "log" | "error" | "debug") => void;

  const sinks: Sink[] = [];

  export function attachFileSink(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "", { flag: "w" });
    const sink: Sink = (line) => {
      try {
        appendFileSync(filePath, line + "\n");
      } catch {}
    };
    sinks.push(sink);
    return () => {
      const i = sinks.indexOf(sink);
      if (i >= 0) sinks.splice(i, 1);
    };
  }

  export function create(prefix?: string) {
    const format = (...messages: any[]) => {
      const formatted = messages.map((msg) => {
        if (msg instanceof Error) {
          return msg.stack || msg.toString();
        }
        if (typeof msg === "object") {
          return inspect(msg, { depth: null, colors: false });
        }
        return msg;
      });
      return `${prefix} ${formatted.join(" ")}`;
    };
    const date = () => new Date().toISOString();
    const fanout = (
      stream: "log" | "error" | "debug",
      ...messages: any[]
    ) => {
      const line = `${date()} ${format(...messages)}`;
      for (const sink of sinks) sink(line, stream);
    };
    return {
      debug: (...messages: any[]) => {
        fanout("debug", ...messages);
        if (process.env.DEBUG !== "true") return;
        console.debug(date(), format(...messages));
      },
      log: (...messages: any[]) => {
        fanout("log", ...messages);
        console.log(date(), format(...messages));
      },
      error: (...messages: any[]) => {
        fanout("error", ...messages);
        console.error(date(), format(...messages));
      },
      format,
      child: (childPrefix: string) =>
        create(prefix ? `${prefix} ${childPrefix}` : childPrefix),
    };
  }
}
