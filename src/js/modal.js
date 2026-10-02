import { t } from './i18n/core.js';

export function showModal({ title='VocaLyx', message='', placeholder='', defaultValue='', showInput=false, confirmText='', cancelText='', showCancel=true }){
  return new Promise((resolve)=>{
    const modal = document.getElementById('appModal');
    const tEl = document.getElementById('modalTitle');
    const mEl = document.getElementById('modalMessage');
    const input = document.getElementById('modalInput');
    const btnCancel = document.getElementById('modalCancel');
    const btnConfirm = document.getElementById('modalConfirm');
    const backdrop = document.getElementById('modalBackdrop');
    const closeBtn = document.getElementById('modalClose');
    if (!modal || !tEl || !mEl || !input || !btnCancel || !btnConfirm) { resolve(null); return; }
    tEl.textContent = title;
    mEl.textContent = message;
    mEl.style.display = message ? 'block' : 'none';
    const formWrap = document.getElementById('modalFormWrap');
    if (formWrap) formWrap.style.display = 'none';
    if (showInput) { input.style.display = 'block'; input.placeholder = placeholder; input.value = defaultValue; setTimeout(()=>input.focus(), 50); }
    else { input.style.display = 'none'; input.value=''; }
    btnCancel.style.display = showCancel ? 'block' : 'none';
    btnCancel.textContent = cancelText || t('modal.cancel');
    btnConfirm.textContent = confirmText || t('modal.ok');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden','false');
    const cleanup = (val)=>{
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden','true');
      btnConfirm.removeEventListener('click', onConfirm);
      btnCancel.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
    };
    const onConfirm = ()=>{
      const v = showInput ? input.value.trim() : true;
      cleanup();
      if (showInput) resolve(v || null);
      else resolve(true);
    };
    const onCancel = ()=>{
      cleanup();
      resolve(showInput ? null : false);
    };
    const onKey = (e)=>{
      if (e.key==='Escape') onCancel();
      if (e.key==='Enter' && showInput) onConfirm();
    };
    btnConfirm.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

export function showPrompt(title, message, defaultValue=''){
  return showModal({ title, message, defaultValue, placeholder: t('ph.playlistName'), showInput:true, confirmText:t('modal.create'), cancelText:t('modal.cancel') });
}

export function showConfirm(title, message, confirmText){
  return showModal({ title, message, showInput:false, confirmText: confirmText || t('modal.delete'), cancelText:t('modal.cancel') });
}

export function showAlert(title, message){
  return showModal({ title, message, showInput:false, confirmText:t('modal.ok'), showCancel:false });
}
