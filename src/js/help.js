import { t } from './i18n/core.js';

const HELP_TOPICS = [
  { id: 'local', steps: 4 },
  { id: 'search', steps: 5 },
  { id: 'playlist', steps: 3 },
  { id: 'iphone', steps: 4 },
  { id: 'karaoke', steps: 4 },
  { id: 'eqlyrics', steps: 4 },
  { id: 'settings', steps: 6 },
  { id: 'cred', steps: 5 },
];

let helpTopic = 'local';
let helpWired = false;

function topicOf(id) {
  return HELP_TOPICS.find((x) => x.id === id) || HELP_TOPICS[0];
}

function paintTopics() {
  const sel = document.getElementById('helpTopicSel');
  if (!sel) return;
  sel.innerHTML = '';
  for (const tp of HELP_TOPICS) {
    const o = document.createElement('option');
    o.value = tp.id;
    o.textContent = t('help.' + tp.id + '.title');
    sel.appendChild(o);
  }
  sel.value = helpTopic;
  if (!helpWired) {
    helpWired = true;
    sel.addEventListener('change', () => {
      helpTopic = sel.value;
      renderHelp();
    });
  }
}

function paintSteps() {
  const tp = topicOf(helpTopic);
  const list = document.getElementById('helpSteps');
  if (!list) return;
  list.innerHTML = '';
  for (let i = 1; i <= tp.steps; i++) {
    const item = document.createElement('div');
    item.className = 'help-step-item';
    const num = document.createElement('span');
    num.className = 'help-step-num';
    num.textContent = String(i);
    const body = document.createElement('div');
    body.className = 'help-step-item-body';
    const titleEl = document.createElement('h3');
    titleEl.className = 'help-step-title';
    titleEl.textContent = t('help.' + tp.id + '.s' + i + 't');
    const textEl = document.createElement('p');
    textEl.className = 'help-step-text';
    textEl.textContent = t('help.' + tp.id + '.s' + i + 'b');
    body.appendChild(titleEl);
    body.appendChild(textEl);
    item.appendChild(num);
    item.appendChild(body);
    list.appendChild(item);
  }
}

export function renderHelp() {
  paintTopics();
  paintSteps();
}

export function resetHelp() {
  helpTopic = 'local';
}
