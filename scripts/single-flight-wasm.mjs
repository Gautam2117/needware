// wasm-bindgen's async initializer can instantiate twice before its `wasm` guard is set.
// Replacing the module-global instance invalidates handles created by the first caller.
export function singleFlightWasm(source) {
  const boundary = 'export { initSync, __wbg_init as default };';
  if (source.split(boundary).length !== 2) throw new Error('Unrecognized wasm-bindgen initialization boundary');
  return source.replace(boundary, `let needwareInitialization;
function needwareInit(input) {
    if (!needwareInitialization) {
        needwareInitialization = __wbg_init(input).catch(error => {
            needwareInitialization = undefined;
            throw error;
        });
    }
    return needwareInitialization;
}
function needwareInitSync(input) {
    if (needwareInitialization && wasm === undefined) throw new Error('Async WASM initialization in progress');
    return initSync(input);
}
export { needwareInitSync as initSync, needwareInit as default };`);
}
