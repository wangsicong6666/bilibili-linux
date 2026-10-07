import { app, net, session, type Session } from "electron";
import { createLogger } from "../../common/log";

const log = createLogger("proxy");

/** bilipc 被映射到本机 3031，不能再进代理，否则白屏。 */
const PROXY_BYPASS = "bilipc.bilibili.com,localhost,127.0.0.1";

let ready: Promise<void> = Promise.resolve();

/** setProxy 完成之前发出的请求会错过代理，调用方需要先等它。 */
export const whenElectronProxyReady = () => ready;

/**
 * Electron 的代理只认 `--proxy-server`（命令行，或 bilibili-flags.conf 里 appendSwitch 的同名开关）。
 * 不读 HTTP(S)_PROXY。getSwitchValue 在个别启动方式下看不到原始 argv，所以两边都看。
 */
const proxyRulesFromElectron = (): string => {
  const fromSwitch = app.commandLine.getSwitchValue("proxy-server").trim();
  if (fromSwitch) return fromSwitch;
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--proxy-server") return (argv[i + 1] || "").trim();
    if (arg.startsWith("--proxy-server=")) {
      return arg.slice("--proxy-server=".length).trim();
    }
  }
  return "";
};

export const electronProxyConfig = (): Electron.ProxyConfig => {
  const proxyRules = proxyRulesFromElectron();
  if (proxyRules) {
    return {
      mode: "fixed_servers",
      proxyRules,
      proxyBypassRules: PROXY_BYPASS,
    };
  }
  // 没写 --proxy-server 时保留系统代理。mode 缺省是 fixed_servers，
  // proxyRules 为空会变成直连，把命令行和系统代理一起清掉。
  return {
    mode: "system",
    proxyBypassRules: PROXY_BYPASS,
  };
};

export const applyElectronProxy = (ses: Session) => {
  const config = electronProxyConfig();
  log.info(
    "session proxy:",
    config.mode,
    config.mode === "fixed_servers" ? config.proxyRules : "(system)"
  );
  return ses.setProxy(config);
};

export const installElectronProxy = () => {
  ready = app.whenReady().then(() => applyElectronProxy(session.defaultSession));
  // webview / partition 各自有 session，命令行代理会被单独的 setProxy 覆盖，这里补上。
  app.on("session-created", (ses) => {
    void ready.then(() => applyElectronProxy(ses));
  });
};

/**
 * 主进程的 Node fetch 不经过 Chromium。换成 net.fetch 后，
 * 检查更新、漫游、空降下载都走 session 上的同一条代理（含绕过规则）。
 */
export const installSessionFetch = () => {
  const nodeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    // net.fetch 不支持 data: / blob:，这两种仍走 Node。
    if (!app.isReady() || url.startsWith("data:") || url.startsWith("blob:")) {
      return nodeFetch(input, init);
    }
    await ready;
    return net.fetch(input as string, init);
  }) as typeof fetch;
};

/**
 * 把 Chromium resolveProxy 的结果收成 URL。
 * gRPC 和 Python 进不了 Chromium 网络栈，只能拿这个地址自己去连。
 * 形如 "PROXY 192.168.1.1:8118"、"SOCKS5 127.0.0.1:1080"、"DIRECT"。
 */
export const electronProxyUrlFor = async (target: string): Promise<string> => {
  await ready;
  const resolved = await session.defaultSession.resolveProxy(target);
  const first = resolved.split(";")[0]?.trim() ?? "";
  const space = first.indexOf(" ");
  if (space <= 0) return "";
  const kind = first.slice(0, space).toUpperCase();
  const address = first.slice(space + 1).trim();
  if (!address) return "";
  if (kind === "PROXY" || kind === "HTTP") return `http://${address}`;
  if (kind === "HTTPS") return `https://${address}`;
  if (kind === "SOCKS5") return `socks5://${address}`;
  if (kind === "SOCKS" || kind === "SOCKS4") return `socks4://${address}`;
  return "";
};
