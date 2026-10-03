import { $, audio, trackListEl, lyricsEl, canvas, ctx, seek, tCur, tLeft } from './js/dom.js';
import { EQ_FREQS, EQ_PRESETS } from './js/eq-data.js';
export { initI18n, applyLang, lang, t, onLangChange, translateTree, syncDocument, i18nBase, i18nLangs, i18nMissing, i18nKeys } from './js/i18n/core.js';
import { initI18n, lang, translateTree } from './js/i18n/core.js';
export { presetLabel, presetList, migrateEqState } from './js/i18n/presets.js';
import { migrateEqState } from './js/i18n/presets.js';
import { fmt, coverHtml, hashStr, escAttr } from './js/format.js';
import { parseLRC, defaultLyrics, lyricLinesToLrc } from './js/lrc.js';
import { showModal, showPrompt, showConfirm, showAlert } from './js/modal.js';
import { colWidths, searchColWidths, applyGridWidths, applySearchGridWidths, initResizableGrid } from './js/grid.js';
import { setupMediaSession, clearMediaSession, setMediaSessionMeta, setMediaSessionState } from './js/media-session.js';
import { S } from './js/state.js';
export { renderTracks, openPortalMenu, closePortalMenu } from './js/tracks.js';
import { renderTracks } from './js/tracks.js';
export { selKeyDL, toggleSelDL, setSelectMode, syncSelHeader } from './js/bulk-select.js';
import { selKeyLocal, toggleSelLocal, syncSelHeader } from './js/bulk-select.js';
export { getMusicFolders, saveMusicFolder, artistKeyOf, albumKeyOf, parentFolderName, localLibraryTracks, savePlaylists, normPath, trackIndexByPath, playlistTracks, plPathIndex, activeDownloadIds, saveDownloadOptions, saveDownloadFolder, saveDownloads, setPlaylistPlayback, clearPlaylistPlayback, setAlbumPlayback, setArtistPlayback, clearCollectionPlayback, saveDownloadPlayback, setDownloadPlayback, clearDownloadPlayback, ensureTrackForPath } from './js/library.js';
import { albumKeyOf, localLibraryTracks, savePlaylists, playlistTracks, plPathIndex, uid, clearPlaylistPlayback, clearCollectionPlayback, clearDownloadPlayback } from './js/library.js';
export { ensureGraph, applyFxState, _rgGainCache, rgTargetDb, prefetchVolumeGain, ensureVolumeGain, applyEnhanceState, applyKaraokeMakeup, previewAudio, setPreviewButton, stopPreview, isPreviewPlaying, playPreviewAudio } from './js/audio-core.js';
import { prefetchVolumeGain } from './js/audio-core.js';
export { AUDIO_EXT_RE, handleLibraryDrop } from './js/iphone-import.js';
import { handleLibraryDrop } from './js/iphone-import.js';
export { renderDeviceView, iphoneTypeOf, loadIPhoneLibrary } from './js/iphone.js';
import { checkIPhoneConnected, loadIPhoneLibrary } from './js/iphone.js';
export { renderSearchView } from './js/search.js';
export { wireCoverDrop, clearActiveCoverDrop, _redlBusy, startTrackDownload } from './js/download-start.js';
import { readCoverPathDrop, wireCoverDrop, clearActiveCoverDrop, onlineCoverHtml, startTrackDownload } from './js/download-start.js';
export { renderMainView, renderPlaylistsOverview, renderPlaylistDetail, groupArtists, groupAlbums, playCollection, renderAlbumDetail, renderArtistDetail } from './js/views.js';
import { renderMainView, renderPlaylistsOverview, renderPlaylistDetail } from './js/views.js';
export { playDownloaded, refreshNpCoverIfCurrent, load, syncPlayerState, play, pause, updatePlayIcon } from './js/player.js';
import { loadSettingsUI, load, syncPlayerState, play } from './js/player.js';
export { editDownloaded } from './js/track-edit.js';
import { editLocalTrack } from './js/track-edit.js';
export { requestDlRender, renderDownloads } from './js/downloads.js';
import { renderDownloads, applyDownloadedFrom } from './js/downloads.js';
export { _viewNeedsTracks } from './js/local.js';
import { rescanMusicFolders, requestMusicRescan, restoreMusicFolders } from './js/local.js';
export { onDownloadFolderChanged } from './js/folders.js';
import { _inFolder, _downloadFolderNorm, normalizeSeparationFlags, isArtifactFileName, cleanupDownloadArtifacts } from './js/folders.js';
export { isTauri, tauriWin, invokeTauri } from './js/tauri.js';
import { isTauri, invokeTauri } from './js/tauri.js';
import { isLocalPath, statLocal, markEnhanced, migrateEnhMarker, pruneEnhMarker, paintEnhanceItem, enhanceOneFile } from './js/enhance.js';
import { showToast, showSep, karaokeStageLabel, karaokeBadgeHtml, karaokeProgressHtml, cudaDeviceLabel, refreshCudaStatus } from './js/engine.js';
import { SRC_LABEL, showAudioNotice, engineHealth, karaokeCaps, karaokeCudaLabel, syncKaraokeBtn } from './js/engine.js';
export { showToast, showSep, karaokeStageLabel, karaokeBadgeHtml, karaokeProgressHtml, cudaDeviceLabel, refreshCudaStatus };
import { pushOsState, pushOsTrack, pushOsPosition, initMediaSync, getNextIndex } from './js/os-media.js';
import { searchViewBox } from './js/theme.js';
import { fetchAndSaveLrclib, renderLyrics, syncLyrics, migrateLyricOffset, pruneLyricOffset, loadLyricOffset } from './js/lyrics.js';
import { setVizHidden } from './js/viz.js';
export { saveEqState, restoreEqState } from './js/eq.js';
import { paintEqKnobs, paintRangeFill } from './js/eq.js';
import { applyLocalSort, sortDownloadRows, sortIPhoneTracks } from './js/sorting.js';
import { ICON } from './js/icons.js';
import { initAbout } from './js/about.js';
import { hydrateIcons } from './js/icons-tabler.js';
export { openLyricEditor, closeLyricEditor, isLyricEditorOpen } from './js/lyrics-editor.js';
import { startBackgroundCheck } from './js/updater.js';


export async function getDownloadFolderEffective(){
  let folder = S.downloadFolder || localStorage.getItem('vocalyx_downloadFolder') || '';
  if (folder) return folder;
  try {
    const { downloadDir, join } = await import('@tauri-apps/api/path');
    folder = await join(await downloadDir(), 'VocaLyx');
  } catch { folder = ''; }
  return folder;
}


window.dumpTracks = function(limit=20){
  const sample = S.tracks.slice(0, limit).map(t=>({title:t.title, path:t.path, ext:t.ext, fromDownloads:!!t.fromDownloads}));
  console.table(sample);
  console.log("downloadPlayback", S.downloadPlayback);
  console.log("downloads", S.downloads.slice(0,5).map(d=>({title:d.title, path:d.path, status:d.status})));
  console.log("localStorage vocalyx_downloadPlayback_v1", localStorage.getItem('vocalyx_downloadPlayback_v1'));
  const bad = S.tracks.filter(t=> !t.path || t.path==="." || t.path==="./" || t.path===".\\");
  if (bad.length) console.warn("BAD tracks with invalid path:", bad);
  else console.log("No BAD tracks found");
  return { sample, badCount: bad.length };
};
try { initI18n(); migrateEqState(); } catch {}
try { translateTree(document); } catch {}
const setLangEl = document.getElementById('setLang');
if (setLangEl) { try { setLangEl.value = lang(); } catch {} }
try { if (typeof window.__syncLangCode === 'function') window.__syncLangCode(lang()); } catch {}
renderTracks();
try { hydrateIcons(document); } catch {}
initResizableGrid();
applySearchGridWidths();
renderMainView();
syncPlayerState();
try { initMediaSync(); } catch {}
try { initAbout(); } catch {}
setTimeout(()=>{ try {
  startBackgroundCheck((r)=>{ try { showToast(t('ab.newVerToast', { v: r.latest }), 7000); } catch {} });
} catch {} }, 4000);
try { restoreMusicFolders(); } catch {}
setTimeout(()=>{ try { cleanupDownloadArtifacts(); } catch {} }, 6000);
engineHealth();
setInterval(engineHealth, 15000);
setInterval(()=>{ if(S.activeView==='device') checkIPhoneConnected(); }, 3000);
(async ()=>{ // engine di-spawn otomatis oleh Tauri; import torch lambat, jadi tunggu banyak sebelum menyerah
  for (let i = 0; i < 60; i++){
    try { if (await engineHealth()) return; } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  showToast('Engine offline — cek log di %APPDATA%\\NetKara\\engine.log', 9000);
})();
