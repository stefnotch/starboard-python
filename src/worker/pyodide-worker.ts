// This worker will not be inlined. Maybe it should, so that it's easier to consume this package without setting up anything?
// Inlining a worker would work, however we might want to be able to use this as both a web worker and a shared worker :thinking:
// btw, the separate entrypoint is so that if we import util.ts, we won't get shared bundles
// after all, imports in web workers don't work in all browsers just yet...
// By the way, please design this so that multiple thingies can access the same worker. Everyone is responsible for their own 'scope' and their own variables, even if this will never work 100%

// Questions:
// - Should the worker stuff be optional?
// - SharedWorker support? (especially for development?)
// - Interrupting? (Make sure to enable COOP/COEP) (Also relevant https://github.com/pyodide/pyodide/pull/852 )
// - Preloading? ( https://github.com/pyodide/pyodide/issues/1576 )
// - Check out asyncio ( https://github.com/pyodide/pyodide/issues/245 )
// - Restarting? ( https://github.com/pyodide/pyodide/issues/703 )
// - Eval code? https://github.com/pyodide/pyodide/pull/1083
/// <reference no-default-lib="true"/>
/// <reference lib="es2020" />
/// <reference lib="WebWorker" />

import "../pyodide/pyodide";
import type { Pyodide as PyodideType } from "../pyodide/typings";
import { assertUnreachable } from "../util";
import { WorkerMessage, WorkerResponse } from "./worker-message";
import { intArrayFromString } from "./emscripten-utils";

// TODO: My lord, is this legal?
// TODO: https://github.com/gzuidhof/console-feed
// https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm
// import { ConsoleCatcher } from "starboard-notebook/dist/src/console/console";

declare global {
  interface WorkerGlobalScope {
    pyodide: PyodideType;
    loadPyodide(config: {
      indexURL: string;
      fs?: {
        stdin: null | (() => any | null);
        stdout: null | ((value: any | null) => void);
        stderr: null | ((value: any | null) => void);
      };
    }): Promise<void>;
  }
}

/**
 * # Async Python research
 * ## pyodide-async
 * It has an autotranslator for basic synchronous code including sleep, which converts it to async.
 * This might be a bit fragile, I haven’t really tested.
 * https://github.com/pyodide/pyodide/issues/97#issuecomment-730561736
 * https://joemarshall.github.io/pyodide-async/
 * ## Interrupt execution
 * sys.settrace() and SharedArrayBuffer
 * https://github.com/pyodide/pyodide/issues/676
 * ## Pyodide console
 * https://github.com/hoodmane/worker-pyodide-console
 * ## Atomics.wait alternatives
 * https://github.com/pyodide/pyodide/issues/1219#issuecomment-776369436
 * https://github.com/pyodide/pyodide/issues/1545#issuecomment-828659003
 * needed if we want to support Safari
 * note: to get a result, one can also do a busy loop after an atomic wait
 * ## Unthrow
 * magical piece of magic to rewind Python to where it used to be
 * https://github.com/pyodide/pyodide/issues/1219#issuecomment-824297183
 * https://github.com/pyodide/pyodide/issues/1545#issuecomment-828659003
 * ## Syncify
 * https://github.com/pyodide/pyodide/pull/1547
 * ## Relevant issues for documentation/commenting
 * Please document everything you did over here
 * https://github.com/pyodide/pyodide/issues/1503
 * https://github.com/pyodide/pyodide/issues/1504
 */

// TODO: Good enough for now, but I'd like to replace it with a console catcher
const originalConsole = self.console;
// TODO: Try to print any python objects that aren't already strings!
// (Can it even happen that this will be called with something that's not a string?)
/*self.console = new Proxy(self.console, {
  get(target, prop, receiver) {
    const method = (target as any)[prop];
    if (method) {
      return function (...args: any[]) {
        self.postMessage({
          type: "console",
          method: prop,
          data: args,
        } as WorkerResponse);
      };
    }
  },
});*/
/*
const consoleCatcher = new ConsoleCatcher(self.console);
function consoleMessageCallback(message: { method: string; data: any[] }) {
  try {
    self.postMessage({
      type: "console",
      method: message.method,
      // TODO: Better copying
      data: JSON.parse(JSON.stringify(message.data)),
    } as WorkerResponse);
  } catch (e) {
    consoleCatcher.getRawConsoleMethods().error(e, "with data", message.data);
  }
}*/

let pyodideLoadSingleton: Promise<void> | undefined = undefined;

self.addEventListener("message", async (e: MessageEvent) => {
  if (!e.data) return;
  const data = e.data as WorkerMessage;
  switch (data.type) {
    case "initialize": {
      if (pyodideLoadSingleton !== undefined) return;

      //consoleCatcher.hook(consoleMessageCallback);
      let artifactsURL = data.options.artifactsUrl || "https://cdn.jsdelivr.net/pyodide/v0.17.0/full/";
      if (!artifactsURL.endsWith("/")) artifactsURL += "/";
      /* self.importScripts(artifactsURL + "pyodide.js"); // Not used, we're importing our own pyodide.ts*/
      (self.pyodide as any).matplotlibHelpers = {
        createElement: (tagName: string) => {
          // TODO:
          console.warn("Unsupported, plez implement");
          /*
            const elem = document.createElement(tagName);
            if (!CURRENT_HTML_OUTPUT_ELEMENT) {
              console.log("HTML output from pyodide but nowhere to put it, will append to body instead.");
              document.querySelector("body")!.appendChild(elem);
            } else {
              CURRENT_HTML_OUTPUT_ELEMENT.appendChild(elem);
            }
            return elem;*/
        },
      };

      let hardcodedOutput = intArrayFromString("cat\n", true, 0);
      let c = 0;
      const fs = {
        stdin() {
          console.log("stdin called");
          if (c >= hardcodedOutput.length) {
            c = 0;
            return null;
          } else {
            let output = hardcodedOutput[c];
            c++;
            return output; // TODO: The 'intArrayFromString' should happen inside of pyodide
          }
        },
        stdout: null, // Keep as default
        stderr: null, // Keep as default
      };

      pyodideLoadSingleton = self.loadPyodide({ indexURL: artifactsURL, fs: fs }).then(() => {
        self.postMessage({
          type: "initialized",
        } as WorkerResponse);
        //consoleCatcher.unhook(consoleMessageCallback);
      });
      break;
    }
    case "run": {
      // TODO: Maybe have our own fancy runner https://github.com/hoodmane/worker-pyodide-console/blob/c681fe223e97fa45a4b8a497b1476459875267df/code.py

      /*
(self as any)["input"] = function (...args: any[]) {
  console.warn(args);
};
//  FS.streams[3]*/

      //consoleCatcher.hook(consoleMessageCallback);
      console.log("Running ", data);
      if (self.pyodide.globals.set) {
        Object.entries(data.data).forEach(([key, value]) => {
          self.pyodide.globals.set?.(key, value); // Should we clear them afterwards again?
        });
      }
      let result = await self.pyodide.runPythonAsync(data.code);
      if (result && result.toJs) {
        result = result.toJs();
        result?.destroy();
      }
      console.log("Result ", result);
      self.postMessage({
        type: "result",
        id: data.id,
        value: result,
      } as WorkerResponse);
      //consoleCatcher.unhook(consoleMessageCallback);
      break;
    }
    default: {
      assertUnreachable(data);
    }
  }
});
