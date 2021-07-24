import { v4 as uuidv4 } from "uuid";
import { AsyncMemory } from "./async-memory";

const SERIALIZATION = {
  UNDEFINED: 0,
  NULL: 1,
  FALSE: 2,
  TRUE: 3,
  NUMBER: 4,
  DATE: 5,
  KNOWN_SYMBOL: 6,
  STRING: 10,
  BIGINT: 11,
  OBJECT: 255,
} as const;

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol
const KNOWN_SYMBOLS = [
  Symbol.asyncIterator,
  Symbol.hasInstance,
  Symbol.isConcatSpreadable,
  Symbol.iterator,
  Symbol.match,
  Symbol.matchAll,
  Symbol.replace,
  Symbol.search,
  Symbol.species,
  Symbol.split,
  Symbol.toPrimitive,
  Symbol.toStringTag,
  Symbol.unscopables,
];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

const encodeFloat = useFloatEncoder();
const decodeFloat = useFloatDecoder();

function useFloatEncoder() {
  // https://stackoverflow.com/a/14379836/3492994
  const temp = new ArrayBuffer(8);
  const tempFloat64 = new Float64Array(temp);
  const tempUint8 = new Uint8Array(temp);

  return function (value: number): Uint8Array {
    tempFloat64[0] = value;
    return tempUint8;
  };
}

function useFloatDecoder() {
  const temp = new ArrayBuffer(8);
  const tempFloat64 = new Float64Array(temp);
  const tempUint8 = new Uint8Array(temp);

  return function (value: Uint8Array): number {
    tempUint8.set(value);
    return tempFloat64[0];
  };
}

/**
 * Lets one other thread access the objects on this thread.
 * Usually runs on the main thread.
 */
export class ObjectProxyHost {
  readonly rootReferences = new Map<string, any>();
  readonly rootReferencesIds = new Map<any, string>();
  readonly temporaryReferences = new Map<string, any>();
  readonly memory: AsyncMemory;

  private writeMemoryContinuation?: () => void;

  constructor(memory: AsyncMemory) {
    this.memory = memory;
  }

  /** Gets or creates a valid, random id for a given object */
  private getId(value: any) {
    const existingId = this.rootReferencesIds.get(value);
    if (existingId) {
      return {
        id: existingId,
        isNew: false,
      };
    } else {
      return { id: uuidv4() + "-" + (typeof value === "function" ? "f" : "o"), isNew: true };
    }
  }

  registerRootObject(value: any) {
    const id = this.getId(value);
    if (id.isNew) {
      this.rootReferences.set(id.id, value);
      this.rootReferencesIds.set(value, id.id);
    }
    return id.id;
  }

  registerTempObject(value: any) {
    const id = this.getId(value);
    if (id.isNew) {
      this.temporaryReferences.set(id.id, value);
    }
    return id.id;
  }

  clearTemporary() {
    this.temporaryReferences.clear();
  }

  getObject(id: string) {
    return this.rootReferences.get(id) ?? this.temporaryReferences.get(id);
  }

  // A serializePostMessage isn't needed here, because all we're ever going to pass to the worker are ids

  serializeMemory(value: any, memory: AsyncMemory) {
    // Format:
    // [1 byte][n bytes ]
    // [type  ][data    ]

    memory.writeSize(8); // Anything that fits into 8 bytes is fine

    // Simple primitives. Guaranteed to fit into the shared memory.
    if (value === undefined) {
      memory.memory[0] = SERIALIZATION.UNDEFINED;
      memory.unlockSize();
    } else if (value === null) {
      memory.memory[0] = SERIALIZATION.NULL;
      memory.unlockSize();
    } else if (value === false) {
      memory.memory[0] = SERIALIZATION.FALSE;
      memory.unlockSize();
    } else if (value === true) {
      memory.memory[0] = SERIALIZATION.TRUE;
      memory.unlockSize();
    } else if (typeof value === "number") {
      memory.memory[0] = SERIALIZATION.NUMBER;
      memory.memory.set(encodeFloat(value), 1);
      memory.unlockSize();
    } else if (value instanceof Date) {
      memory.memory[0] = SERIALIZATION.DATE;
      const time = value.getTime();
      memory.memory.set(encodeFloat(time), 1);
      memory.unlockSize();
    } else if (typeof value === "symbol" && KNOWN_SYMBOLS.includes(value)) {
      memory.memory[0] = SERIALIZATION.KNOWN_SYMBOL;
      memory.memory[1] = KNOWN_SYMBOLS.indexOf(value);
      memory.unlockSize();
    }
    // Variable length primitives. Not guaranteed to fit into the shared memory, but we know their size.
    else if (typeof value === "string") {
      memory.memory[0] = SERIALIZATION.STRING;
      // A string encoded in utf-8 uses at most 4 bytes per character
      if (value.length * 4 <= memory.memory.byteLength) {
        const data = textEncoder.encode(value);
        memory.memory.set(data, 1);
        memory.writeSize(data.byteLength);
        memory.unlockSize();
      } else {
        // Longer strings need to be sent piece by piece
        const bytes = textEncoder.encode(value);
        const memorySize = memory.memory.byteLength;
        let offset = 0;
        let remainingBytes = bytes.byteLength;
        memory.memory.set(bytes.subarray(offset, memorySize - 1), 1);
        offset += memorySize - 1;
        remainingBytes -= memorySize - 1;
        this.writeMemoryContinuation = () => {
          if (remainingBytes > 0) {
            memory.memory.set(bytes.subarray(offset, memorySize), 0);
            offset += memorySize;
            remainingBytes -= memorySize;
          } else {
            this.writeMemoryContinuation = undefined;
          }
          memory.unlockSize();
        };
        memory.writeSize(bytes.byteLength);
        memory.unlockSize();
      }
    } else if (typeof value === "bigint") {
      memory.memory[0] = SERIALIZATION.BIGINT;
      const digits = value.toString();
      // TODO: Implement this (just like the text ^)
      console.warn("Not implemented");
      memory.unlockSize();
    }
    // Object. Serialized as ID, guaranteed to fit into shared memory
    else {
      memory.memory[0] = SERIALIZATION.OBJECT;
      const id = this.registerTempObject(value);
      const data = textEncoder.encode(id);
      memory.memory.set(data, 1);
      memory.writeSize(data.byteLength);
      memory.unlockSize();
    }
  }

  /**
   * Deserializes an object that was sent through postMessage
   */
  deserializePostMessage(value: any): any {
    if (typeof value === "object" && value !== null) {
      // Special cases
      if (value.id) return this.getObject(value.id);
      if (value.symbol) return KNOWN_SYMBOLS[value.symbol];
      if (value.value) return value.value;
      if (value.array) {
        // Deserialize proxies in arrays
        return value.array.map((v: any) => (v.id ? this.getObject(v.id) : v.value));
      }
    }
    // It's a primitive
    return value;
  }

  handleProxyMessage(message: ProxyMessage, memory: AsyncMemory) {
    if (message.type === "proxy-reflect") {
      try {
        const method = Reflect[message.method];
        const target = this.getObject(message.target);
        const args = (message.arguments ?? []).map((v) => this.deserializePostMessage(v));
        console.log([message.method, target, args]);
        const result = (method as any)(target, ...args);
        console.log([message.method, result]);
        // Write result to shared memory
        this.serializeMemory(result, memory);
      } catch (e) {
        console.error(message);
        throw e;
      }
    } else if (message.type === "proxy-shared-memory") {
      // Write remaining data to shared memory
      if (this.writeMemoryContinuation === undefined) {
        console.warn("No more data to write to shared memory");
      } else {
        this.writeMemoryContinuation();
      }
    } else {
      console.warn("Unknown proxy message", message);
    }
  }
}

export const ObjectId = Symbol("id");
export const IsProxy = Symbol("is-proxy");
/**
 * Allows this thread to access objects from another thread.
 * Must run on a worker thread.
 */
export class ObjectProxyClient {
  readonly memory: AsyncMemory;
  readonly postMessage: (message: ProxyMessage) => void;
  constructor(memory: AsyncMemory, postMessage: (message: ProxyMessage) => void) {
    this.memory = memory;
    this.postMessage = postMessage;
  }

  /**
   * Serializes an object so that it can be sent using postMessage
   */
  serializePostMessage(value: any): any {
    if (isSimplePrimitive(value)) {
      return value;
    } else if (isSymbolPrimitive(value)) {
      return { symbol: KNOWN_SYMBOLS.indexOf(value) };
    } else if (isVariableLengthPrimitive(value)) {
      return value;
    } else if (value[ObjectId] !== undefined) {
      return { id: value[ObjectId] };
    } else {
      // Maybe serialize simple functions https://stackoverflow.com/questions/1833588/javascript-clone-a-function
      // Serialize proxies in arrays
      if (Array.isArray(value) && value.find((v) => v[ObjectId] !== undefined)) {
        return { array: value.map((v) => (v[ObjectId] !== undefined ? { id: v[ObjectId] } : { value: v })) };
      } else {
        return { value: value }; // Might fail to get serialized
      }
    }
  }

  /**
   * Deserializes an object from a shared array buffer. Can return a proxy.
   */
  deserializeMemory(memory: AsyncMemory) {
    const numberOfBytes = memory.readSize();

    // Uint8Arrays have the convenient property of having 1 byte per element.
    let resultBytes: Uint8Array;
    if (numberOfBytes <= memory.sharedMemory.byteLength) {
      resultBytes = memory.memory;
    } else {
      const memorySize = memory.sharedMemory.byteLength;
      let offset = 0;
      let remainingBytes = numberOfBytes;
      resultBytes = new Uint8Array(numberOfBytes);
      while (remainingBytes >= memorySize) {
        resultBytes.set(memory.memory, offset);
        offset += memorySize;
        remainingBytes -= memorySize;
        memory.lockSize();
        this.postMessage({ type: "proxy-shared-memory" });
        memory.waitForSize();
      }
      if (remainingBytes > 0) {
        resultBytes.set(memory.memory.subarray(0, remainingBytes), offset);
      }
    }

    // Simple primitives. Guaranteed to fit into the shared memory.
    if (resultBytes[0] === SERIALIZATION.UNDEFINED) {
      return undefined;
    } else if (resultBytes[0] === SERIALIZATION.NULL) {
      return null;
    } else if (resultBytes[0] === SERIALIZATION.FALSE) {
      return false;
    } else if (resultBytes[0] === SERIALIZATION.TRUE) {
      return true;
    } else if (resultBytes[0] === SERIALIZATION.NUMBER) {
      return decodeFloat(resultBytes.subarray(1, 9));
    } else if (resultBytes[0] === SERIALIZATION.DATE) {
      const date = new Date();
      date.setTime(decodeFloat(resultBytes.subarray(1, 9)));
      return date;
    } else if (resultBytes[0] === SERIALIZATION.KNOWN_SYMBOL) {
      const symbol = KNOWN_SYMBOLS[resultBytes[1]];
      return symbol;
    }
    // Variable length primitives. We already read all of their data
    else if (resultBytes[0] === SERIALIZATION.STRING) {
      // Note: This *copies* the entire thing, because you aren't allowed to call decode on a SharedArrayBuffer
      return textDecoder.decode(resultBytes.slice(1, numberOfBytes + 1));
    } else if (resultBytes[0] === SERIALIZATION.BIGINT) {
      return BigInt(textDecoder.decode(resultBytes.slice(1, numberOfBytes + 1)));
    }
    // Object. Serialized as ID, guaranteed to fit into shared memory
    else if (resultBytes[0] === SERIALIZATION.OBJECT) {
      const id = textDecoder.decode(resultBytes.slice(1, numberOfBytes + 1));
      return this.getObjectProxy(id);
    } else {
      console.warn("Unknown type", resultBytes[0]);
      return null;
    }
  }

  /**
   * Calls a Reflect function on an object from the other thread
   * @returns The result of the operation, can be a primitive or a proxy
   */
  private proxyReflect(method: keyof typeof Reflect, targetId: string, args: any[]) {
    // TODO: Rewrite this a bit
    try {
      this.memory.lock();
      let value = undefined;
      try {
        this.postMessage({
          type: "proxy-reflect",
          method: method,
          target: targetId,
          arguments: args.map((v) => this.serializePostMessage(v)),
        });
        this.memory.waitForSize();
        value = this.deserializeMemory(this.memory);
      } catch (e) {
        console.error({ method, targetId, args });
        console.error(e);
        try {
          this.memory.unlockSize();
        } catch (e) {}
      }

      this.memory.unlockWorker();
      return value;
    } catch (e) {
      console.error({ method, targetId, args });
      console.error(e);
    }
  }

  /** Checks if an id encodes a function. Mostly a silly hack to ensure that proxies can work as expected */
  private isFunction(id: string) {
    return id.endsWith("-f");
  }

  /**
   * Gets a proxy object for a given id
   */
  getObjectProxy<T = any>(
    id: string,
    // TODO: Take the ID and check if such a proxy already exists (weakmap)
    // TODO: Every proxy has certain exclusions
    // 1. properties to directly pass to the underlying object
    // 2. functions that can be called on both threads (main or worker) (e.g. setTimeout with a main-thread-function as callback)
    // 3. when returning another object-proxy, it will get its own list of exclusions
    // TODO: fast paths for
    // 4. functions that don't return anything (no need to block the worker until they're done executing)
    // TODO: special paths for
    // 5. callbacks (addEventListener)
    /**
     * Suggested API:
     * registerExclusions(object) (main thread)
     * --> creates an exclusion-list-object and gives it an ID. it then sends that to the web worker
     * --> whenever that object gets an ID, we send the web worker the exclusion-list-id
     * registerExclusions(type) (main thread)
     * --> whenever an object with that type gets an ID, we tell the web worker which exclusion-list to use
     * registerExclusions(id) (worker thread)
     * --> whenever a proxy is created, we give it those exclusions
     */
    // TODO: When a property value is being obtained, call 'Object.getOwnPropertyDescriptor'
    //       then we can figure out if it's a 'get' or 'value'. If it's just a 'value', then
    //       we can return the value and tell the other side to cache it
    // TODO: Regarding caching properties when they're accessed (functions are a prime target) (Object.getOwnPropertyDescriptor?)
    // TODO: Recursive exclusions (e.g. globalThis.window.window.window)
    // TODO: add a finalizer to all temp objects with IDs on the main thread and tell the web worker to drop that ID?
    //       or do it the other way around?
    options?: {
      exclude: {
        props: Set<string>;
        obj: any;
      };
    }
  ): T {
    const client = this;

    return new Proxy(this.isFunction(id) ? function () {} : {}, {
      get(target, prop, receiver) {
        if (prop === ObjectId) {
          return id;
        }
        if (prop === IsProxy) {
          return true;
        }
        // TODO: Remove this quick n dirty hack
        if (prop === "setTimeout") {
          return function (handler: any, timeout: any, ...args: any[]) {
            return globalThis.setTimeout(handler, timeout, ...args);
          };
        }

        // const value = Reflect.get(target, prop, receiver);
        const value = client.proxyReflect("get", id, [prop, receiver]);

        if (typeof value !== "function") return value;
        /* Functions need special handling
         * https://stackoverflow.com/questions/27983023/proxy-on-dom-element-gives-error-when-returning-functions-that-implement-interfa
         * https://stackoverflow.com/questions/37092179/javascript-proxy-objects-dont-work
         */
        return new Proxy(value, {
          apply(_, thisArg, args) {
            // thisArg: the object the function was called with. Can be the proxy or something else
            // receiver: the object the propery was gotten from. Is always the proxy or something inheriting from the proxy
            // target: the original object

            const calledWithProxy = thisArg[IsProxy];
            // return Reflect.apply(value, calledWithProxy ? target : thisArg, args);
            const value = client.proxyReflect("apply", calledWithProxy ? id : thisArg[ObjectId], args ?? []);
            return value;
          },
        });
      },
      set(target, prop, value, receiver) {
        // return Reflect.set(target, prop, value, receiver);
        return client.proxyReflect("set", id, [prop, value, receiver]);
      },
      ownKeys(target) {
        // return Reflect.ownKeys(target);
        return client.proxyReflect("ownKeys", id, []);
      },
      has(target, prop) {
        // return Reflect.has(target, prop);
        return client.proxyReflect("has", id, [prop]);
      },
      defineProperty(target, prop, attributes) {
        // return Reflect.defineProperty(target, prop, attributes);
        return client.proxyReflect("defineProperty", id, [prop, attributes]);
      },
      deleteProperty(target, prop) {
        // return Reflect.deleteProperty(target, prop);
        return client.proxyReflect("deleteProperty", id, [prop]);
      },
      // TODO: Those functions might be interesting as well
      /*
      getOwnPropertyDescriptor(target, prop) {
        // return Reflect.getOwnPropertyDescriptor(target, prop);
        return client.proxyReflect("getOwnPropertyDescriptor", id, [prop]);
      },
      isExtensible(target) {
        // return Reflect.isExtensible(target);
        return client.proxyReflect("isExtensible", id, []);
      },
      preventExtensions(target) {
        // return Reflect.preventExtensions(target);
        return client.proxyReflect("preventExtensions", id, []);
      },
      getPrototypeOf(target) {
        // return Reflect.getPrototypeOf(target);
        return client.proxyReflect("getPrototypeOf", id, []);
      },
      setPrototypeOf(target, proto) {
        // return Reflect.setPrototypeOf(target, proto);
        return client.proxyReflect("setPrototypeOf", id, [proto]);
      },*/

      // For function objects
      apply(target, thisArg, argumentsList) {
        // Note: It can happen that a function gets called with a thisArg that cannot be serialized (due to it being an object on the worker thread)
        // One solution is to provide a `[ObjectId]: ""` property
        // return Reflect.apply(target, thisArg, argumentsList);
        return client.proxyReflect("apply", id, [thisArg, argumentsList]);
      },
      construct(target, argumentsList, newTarget) {
        // return Reflect.construct(target, argumentsList, newTarget)
        return client.proxyReflect("construct", id, [argumentsList, newTarget]);
      },
    }) as T;
  }

  /**
   * Wraps an object in a proxy that does not proxy certain properties
   */
  wrapExcluderProxy<T extends object>(obj: T, underlyingObject: T, exclude: Set<string | Symbol>): T {
    // This isn't the best solution, see https://github.com/gzuidhof/starboard-python/pull/5#issuecomment-885693105
    // Maybe unwrap the proxy and create a new one which can do the job of both?
    return new Proxy<T>(obj, {
      get(target, prop, receiver) {
        if (exclude.has(prop)) {
          target = underlyingObject;
        }
        if (prop === IsProxy) {
          return true;
        }

        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return new Proxy(value, {
          apply(_, thisArg, args) {
            const calledWithProxy = thisArg[IsProxy];
            return Reflect.apply(value, calledWithProxy ? target : thisArg, args);
          },
        });
      },
      set(target, prop, value, receiver) {
        console.log("exc set");
        return Reflect.set(target, prop, value, receiver);
      },
      ownKeys(target) {
        console.log("excluder ownkeys");
        return Reflect.ownKeys(target);
      },
      has(target, prop) {
        if (exclude.has(prop)) {
          target = underlyingObject;
        }
        return Reflect.has(target, prop);
      },
      defineProperty(target, prop, attributes) {
        console.log("exc def");
        return Reflect.defineProperty(target, prop, attributes);
      },
      deleteProperty(target, prop) {
        console.log("exc del");
        return Reflect.deleteProperty(target, prop);
      },
    });
  }
}

function isSimplePrimitive(value: any) {
  if (value === undefined) {
    return true;
  } else if (value === null) {
    return true;
  } else if (value === false) {
    return true;
  } else if (value === true) {
    return true;
  } else if (typeof value === "number") {
    return true;
  } else if (value instanceof Date) {
    return true;
  } else {
    return false;
  }
}

function isSymbolPrimitive(value: any) {
  if (typeof value === "symbol" && KNOWN_SYMBOLS.includes(value)) {
    return true;
  }
  return false;
}

function isVariableLengthPrimitive(value: any) {
  if (typeof value === "string") {
    return true;
  } else if (typeof value === "bigint") {
    return true;
  }
}

export type ProxyMessage =
  | {
      type: "proxy-reflect";
      method: keyof typeof Reflect;
      /**
       * An object id
       */
      target: string;
      /**
       * Further parameters. Have to be serialized
       */
      arguments?: any[];
    }
  | {
      /** For requesting more bytes from the shared memory*/
      type: "proxy-shared-memory";
    };
