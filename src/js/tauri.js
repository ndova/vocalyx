
export const isTauri = () => !!window.__TAURI_INTERNALS__;

export async function tauriWin(fn) {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await fn(getCurrentWindow());
  } catch {}
}

export async function invokeTauri(cmd, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd, args);
}

export {  };
