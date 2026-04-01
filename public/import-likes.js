(function () {
  const host = window.location.hostname || '';
  const onApiHost = /\.onrender\.com$/i.test(host) || host === 'localhost' || host === '127.0.0.1';
  const API_BASE_URL = onApiHost
    ? `${window.location.protocol}//${window.location.host}`
    : 'https://you-liked-what-backend.onrender.com';
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const folderInput = document.getElementById('folder-input');
  const btnPickFiles = document.getElementById('btn-pick-files');
  const btnPickFolder = document.getElementById('btn-pick-folder');
  const btnSend = document.getElementById('btn-send');
  const statusEl = document.getElementById('import-status');
  const errEl = document.getElementById('import-error');
  const resultSection = document.getElementById('import-result');
  const uploadSection = document.getElementById('import-upload-section');
  const resultText = document.getElementById('import-result-text');

  /** @type {File[]} */
  let staged = [];

  function setStatus(msg) {
    statusEl.textContent = msg || '';
  }

  function setError(msg) {
    if (!msg) {
      errEl.classList.add('hidden');
      errEl.textContent = '';
      return;
    }
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
  }

  function syncStaged(files) {
    const list = Array.from(files || []).filter(Boolean);
    staged = list;
    btnSend.disabled = list.length === 0;
    if (list.length === 0) {
      setStatus('');
      return;
    }
    const names = list.slice(0, 4).map((f) => f.name);
    const more = list.length > 4 ? ` … +${list.length - 4} autre(s)` : '';
    setStatus(`${list.length} fichier(s) prêt(s) : ${names.join(', ')}${more}`);
  }

  function apiFetch(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    let url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
    if (method === 'GET' && !url.includes('_nc=')) {
      url += (url.includes('?') ? '&' : '?') + `_nc=${Date.now()}`;
    }
    const h = new Headers(options.headers || {});
    h.set('ngrok-skip-browser-warning', '69420');
    return fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      ...options,
      headers: h,
    });
  }

  async function checkSession() {
    try {
      const r = await apiFetch('/api/health');
      const ct = (r.headers.get('content-type') || '').includes('application/json');
      if (!r.ok || !ct) {
        setError('Réponse serveur inattendue. Vérifie l’URL du backend.');
        return false;
      }
      const j = await r.json();
      if (!j.session || !j.session.authenticated) {
        setError('Tu n’es pas connecté. Va sur la page d’accueil, connecte-toi, puis reviens ici.');
        btnSend.disabled = true;
        return false;
      }
      setError('');
      return true;
    } catch (_) {
      setError('Impossible de joindre le serveur. Lance le site (npm start) et réessaie.');
      return false;
    }
  }

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  btnPickFiles.addEventListener('click', () => fileInput.click());
  btnPickFolder.addEventListener('click', () => folderInput.click());

  ['dragenter', 'dragover'].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drop-zone--active');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drop-zone--active');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (!dt || !dt.files) return;
    syncStaged(dt.files);
  });

  fileInput.addEventListener('change', () => {
    syncStaged(fileInput.files);
    folderInput.value = '';
  });

  folderInput.addEventListener('change', () => {
    syncStaged(folderInput.files);
    fileInput.value = '';
  });

  btnSend.addEventListener('click', async () => {
    setError('');
    if (staged.length === 0) return;
    const ok = await checkSession();
    if (!ok) return;

    const fd = new FormData();
    staged.forEach((f) => fd.append('files', f, f.name));

    btnSend.disabled = true;
    setStatus('Analyse en cours… Merci de patienter (gros fichiers = plus long).');

    try {
      const r = await apiFetch('/auth/likes/import-export', {
        method: 'POST',
        body: fd,
      });
      const j = await r.json().catch(() => ({}));

      if (!r.ok) {
        setStatus('');
        btnSend.disabled = false;
        setError(j.error || `Erreur ${r.status}`);
        return;
      }

      if (!j.ok) {
        setStatus('');
        btnSend.disabled = false;
        setError(j.error || 'Import impossible.');
        return;
      }

      const pool = j.totalInGamePool != null ? j.totalInGamePool : (j.simulatedLikes && j.simulatedLikes.length) || 0;
      const dbTotal = j.totalInDatabase != null ? j.totalInDatabase : pool;
      resultText.textContent =
        `Nous avons reconnu ${j.importedUnique} post(s) dans ton export et mis à jour ta bibliothèque. ` +
        `Pour la partie, on utilise jusqu’à ${pool} post(s) les plus récents (tu en as ${dbTotal} au total enregistrés). ` +
        (j.canPlay ? 'Tu peux lancer une partie.' : 'Ajoute encore quelques posts ou refais un import pour atteindre le minimum.');
      uploadSection.classList.add('hidden');
      resultSection.classList.remove('hidden');
    } catch (e) {
      setStatus('');
      btnSend.disabled = staged.length > 0;
      setError('Erreur réseau ou serveur. Réessaie dans un instant.');
    }
  });

  checkSession();
})();
