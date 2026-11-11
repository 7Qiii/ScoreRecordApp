/**
 * 给 Node 铺一层最小的浏览器环境，好让 src/ 下的 store 能跑起来。
 *
 * 为什么不装 jsdom / happy-dom：
 * 这个项目目前 devDependencies 是空的 —— 所有校验脚本（check-bindings、
 * check-dialogs、audit-a11y…）都只用 node_modules 里已有的东西跑。
 * 为了一个 store 测试破例引入 DOM 实现，和既有约定不一致；而且这里真正
 * 需要的浏览器能力少得可怜，几十行就够了。
 *
 * 为什么不需要 IndexedDB：
 * Dexie 是懒的 —— 不调用写操作就不会去开库。测试里把 db 的表方法换成内存桩
 * （见 stubDatabase），要测的是 store 的逻辑，不是 Dexie 的持久化。
 *
 * 定时器为什么要自己记账：
 * store 里 notify() 会挂 3.2 秒的 setTimeout，addRecord() 会触发
 * scheduleAutoSync() 再挂一个。这些句柄不清掉，Node 进程会一直挂着不退出 ——
 * 而且「进程能自然退出」本身就是个有用的断言：说明没有泄漏的定时器。
 */

const timers = new Set();
const intervals = new Set();

function trackedTimeout(callback, delay, ...args) {
  const id = setTimeout(() => {
    timers.delete(id);
    callback(...args);
  }, delay);
  timers.add(id);
  return id;
}

function trackedInterval(callback, delay, ...args) {
  const id = setInterval(callback, delay, ...args);
  intervals.add(id);
  return id;
}

/**
 * document 桩。
 *
 * 这里不是要造一个能用的 DOM —— 只是为了让 @vue/runtime-dom 的模块初始化不炸：
 * 它一加载就会执行 `doc.createElement("template")`（见 runtime-dom 顶部），
 * document 存在但没有 createElement 的话，直接 TypeError。
 * 所以给了 createElement 这类方法，返回一个不会真的被使用的空壳节点。
 *
 * 如果哪天真的需要渲染组件（mount），那就得换成 jsdom / happy-dom ——
 * 这个桩只会让渲染以更难懂的方式失败。它服务的范围是「import store 并调它的逻辑」。
 */
function createStubNode(tagName = "") {
  const node = {
    tagName: String(tagName).toUpperCase(),
    style: {},
    dataset: {},
    content: {},
    innerHTML: "",
    textContent: "",
    childNodes: [],
    children: [],
    firstChild: null,
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    appendChild: (child) => child,
    removeChild: (child) => child,
    insertBefore: (child) => child,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => []
  };
  return node;
}

function createDocumentStub(addEventListener, removeEventListener) {
  const documentStub = {
    hidden: false,
    visibilityState: "visible",
    addEventListener,
    removeEventListener,
    createElement: (tagName) => createStubNode(tagName),
    createElementNS: (namespace, tagName) => createStubNode(tagName),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    createComment: (text) => ({ nodeType: 8, textContent: String(text) }),
    createDocumentFragment: () => createStubNode("#fragment"),
    querySelector: () => null,
    querySelectorAll: () => []
  };
  documentStub.body = createStubNode("body");
  documentStub.documentElement = createStubNode("html");
  documentStub.head = createStubNode("head");
  return documentStub;
}

export function installBrowserEnv({ viteEnv = {} } = {}) {
  // Vite 在构建时把 import.meta.env 注入进去，Node 里没有。
  // scripts/lib/vite-shim.mjs 会把源码里的 import.meta.env 换成
  // globalThis.__viteEnv，所以这里塞的值就是「构建时的环境变量」。
  globalThis.__viteEnv = { ...viteEnv };

  const memory = new Map();
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
    clear: () => memory.clear(),
    key: (index) => [...memory.keys()][index] ?? null,
    get length() {
      return memory.size;
    }
  };

  // hostname 故意用 localhost：supabase.js 里 shouldUseSupabaseProxy()
  // 看到 localhost 会返回 false，于是不会去拼 window.location.origin 的代理地址，
  // 也不会因为没有 VITE_SUPABASE_URL 而走到 createClient。
  const location = {
    hostname: "localhost",
    origin: "http://localhost:5173",
    href: "http://localhost:5173/",
    protocol: "http:"
  };

  const listeners = new Map();
  const addEventListener = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
  };
  const removeEventListener = (type, handler) => {
    listeners.get(type)?.delete(handler);
  };

  globalThis.localStorage = storage;

  globalThis.window = {
    localStorage: storage,
    location,
    setTimeout: trackedTimeout,
    clearTimeout: (id) => {
      timers.delete(id);
      clearTimeout(id);
    },
    setInterval: trackedInterval,
    clearInterval: (id) => {
      intervals.delete(id);
      clearInterval(id);
    },
    addEventListener,
    removeEventListener,
    dispatchEvent: (event) => {
      listeners.get(event?.type)?.forEach((handler) => handler(event));
      return true;
    }
  };

  globalThis.document = createDocumentStub(addEventListener, removeEventListener);

  return {
    storage,
    /** 触发某个 window/document 事件，用来测 focus / online / visibilitychange 分支。 */
    dispatch(type, event = {}) {
      listeners.get(type)?.forEach((handler) => handler({ type, ...event }));
    },
    /** 清掉所有挂着的定时器，让进程能自然退出。返回清掉的数量。 */
    cleanup() {
      timers.forEach((id) => clearTimeout(id));
      intervals.forEach((id) => clearInterval(id));
      const cleared = timers.size + intervals.size;
      timers.clear();
      intervals.clear();
      listeners.clear();
      return cleared;
    }
  };
}

/**
 * 把 Dexie 的表方法换成内存实现。
 *
 * 必须在 import store 之后调用：db 是 storage.js 的模块级单例，
 * store 通过 `import { db }` 拿到的是同一个对象引用，所以改它的属性
 * store 是看得见的（ESM 的 import 绑定不可重新赋值，但对象内容可以改）。
 */
export function stubDatabase(db, { seed = {} } = {}) {
  const tables = ["subjects", "records", "mistakes", "images", "deletedRecords"];
  const rows = new Map(tables.map((name) => [name, [...(seed[name] || [])]]));

  for (const name of tables) {
    const table = rows.get(name);
    db[name] = {
      get: async (id) => table.find((row) => row.id === id),
      bulkGet: async (ids) => ids.map((id) => table.find((row) => row.id === id)),
      put: async (value) => {
        const index = table.findIndex((row) => row.id === value.id);
        if (index >= 0) table[index] = value;
        else table.push(value);
        return value.id;
      },
      bulkPut: async (values) => {
        for (const value of values) {
          const index = table.findIndex((row) => row.id === value.id);
          if (index >= 0) table[index] = value;
          else table.push(value);
        }
      },
      update: async (id, patch) => {
        const row = table.find((item) => item.id === id);
        if (row) Object.assign(row, patch);
        return row ? 1 : 0;
      },
      delete: async (id) => {
        const index = table.findIndex((row) => row.id === id);
        if (index >= 0) table.splice(index, 1);
      },
      bulkDelete: async (ids) => {
        const remove = new Set(ids);
        for (let index = table.length - 1; index >= 0; index -= 1) {
          if (remove.has(table[index].id)) table.splice(index, 1);
        }
      },
      toArray: async () => table.map((row) => ({ ...row })),
      count: async () => table.length,
      clear: async () => table.splice(0, table.length)
    };
  }

  // replaceAllData() 走的是 db.transaction("rw", ...)，那是 Dexie 的真方法 ——
  // Node 里没有 IndexedDB，一调用就炸。桩里直接把回调执行掉，不做隔离：
  // 要测的是「事务里做了哪些写操作」，不是 Dexie 的事务语义。
  db.transaction = async (...args) => {
    const callback = args[args.length - 1];
    return typeof callback === "function" ? callback() : undefined;
  };
  db.open = async () => db;

  return {
    rows,
    read: (name) => rows.get(name).map((row) => ({ ...row })),
    /**
     * 原地替换表内容，**不能**用 rows.set(name, [...values]) 换数组。
     *
     * 各表方法（put / bulkPut / count …）都是闭包捕获上面那个 table 引用，
     * 一旦 write 把 Map 里的数组换成新的，db.records.count() 读旧数组、
     * dbStub.read() 读新数组，两边就是两个不同的表了 —— 断言会在一个
     * 「幻影数据库」上通过或失败。踩过一次：seedIfEmpty 明明正确地在
     * 空库时灌了种子，测试却读到 0，因为 count() 看到的还是替换前那批数据。
     */
    write: (name, values) => {
      const table = rows.get(name);
      table.length = 0;
      table.push(...values);
    }
  };
}
