/**
 * 在 127.0.0.1 上挑一个 Chrome 不会拒绝的端口。
 *
 * 为什么需要这个：
 *   这些校验脚本都用 `server.listen(0, ...)` 让系统从临时端口段里随便挑一个。
 *   但 Chrome 有一张「不安全端口」黑名单（net/base/port_util.cc 的
 *   kRestrictedPorts），命中就报 `net::ERR_UNSAFE_PORT`，页面根本打不开。
 *   Windows 的临时端口段是 49152–65535，和黑名单里的 6000 / 6566 /
 *   6665–6669 / 6697 / 10080 有重叠 —— 于是脚本会**偶发**失败：
 *   看起来像代码坏了，其实只是端口抽签抽到了雷，重跑一次就好了。
 *   「重跑一次就好了」的失败最消耗信任，所以这里显式排掉。
 *
 * 用法：
 *   const { server, port } = await listenSafe(handler);   // 自己建 server
 *   const port = await listenSafePort(server);            // 已有 server，只想换端口
 */
import { createServer } from "node:http";

/** Chromium net/base/port_util.cc 里的 kRestrictedPorts */
const RESTRICTED = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080
]);

export const isRestrictedPort = (port) => RESTRICTED.has(port);

/**
 * 给一个**已经创建好但还没 listen** 的 server 挑一个安全端口。
 * 抽到黑名单里的端口就关掉重来。
 */
export async function listenSafePort(server) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const port = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    if (!RESTRICTED.has(port)) return port;
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error("连续 25 次抽到的端口都在 Chrome 的不安全端口黑名单里，换台机器试试");
}

/** 一步到位：建 server + 挑安全端口。 */
export async function listenSafe(handler) {
  const server = createServer(handler);
  const port = await listenSafePort(server);
  return { server, port };
}
