export let colWidths = [30, null, 44, 58, 72];
export let detailColWidths = [30, null, 44, 58, 72, 30];
export let searchColWidths = [30, null, 58, 80];

function toCols(widths) {
  return widths.map(w => w === null ? '1fr' : w + 'px').join(' ');
}

export function applyGridWidths() {
  const cols = toCols(colWidths);
  const detailCols = toCols(detailColWidths);
  const head = document.getElementById('tableHead');
  if (head) head.style.gridTemplateColumns = cols;
  const detailHead = document.getElementById('detailTableHead');
  if (detailHead) detailHead.style.gridTemplateColumns = detailCols;
  const iphoneHead = document.getElementById('iphoneTableHead');
  if (iphoneHead) iphoneHead.style.gridTemplateColumns = cols;
  document.querySelectorAll('#trackList .track, #iphoneTrackList .track').forEach(el => el.style.gridTemplateColumns = cols);
  document.querySelectorAll('#detailTrackList .track').forEach(el => el.style.gridTemplateColumns = detailCols);
}

export function applySearchGridWidths() {
  const cols = searchColWidths.map(w => w === null ? '1fr' : w + 'px').join(' ');
  const head = document.getElementById('searchTableHead');
  if (head) head.style.gridTemplateColumns = cols;
  document.querySelectorAll('#searchTrackList .track').forEach(el => el.style.gridTemplateColumns = cols);
}

export function initResizableGrid() {
  document.querySelectorAll('.resizer[data-col]').forEach(resizer => {
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const col = parseInt(resizer.dataset.col, 10);
      const headerCell = resizer.parentElement;
      const startX = e.clientX;
      const startWidth = headerCell.offsetWidth;
      if (colWidths[col] === null) colWidths[col] = startWidth;
      document.body.classList.add('resizing');
      const onMove = (ev) => {
        const delta = ev.clientX - startX;
        let newWidth = startWidth + delta;
        const min = col === 1 ? 100 : 30;
        const max = col === 1 ? 500 : 180;
        newWidth = Math.max(min, Math.min(max, newWidth));
        colWidths[col] = Math.round(newWidth);
        applyGridWidths();
      };
      const onUp = () => {
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
  document.querySelectorAll('.resizer[data-scol]').forEach(resizer => {
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const col = parseInt(resizer.dataset.scol, 10);
      const headerCell = resizer.parentElement;
      const startX = e.clientX;
      const startWidth = headerCell.offsetWidth;
      if (searchColWidths[col] === null) searchColWidths[col] = startWidth;
      document.body.classList.add('resizing');
      const onMove = (ev) => {
        const delta = ev.clientX - startX;
        let newWidth = startWidth + delta;
        const min = col === 1 ? 120 : 40;
        const max = col === 1 ? 600 : 220;
        newWidth = Math.max(min, Math.min(max, newWidth));
        searchColWidths[col] = Math.round(newWidth);
        applySearchGridWidths();
      };
      const onUp = () => {
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}
