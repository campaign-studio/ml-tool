/* ═══════════════════════════════ i18n / STRINGS CENTRALIZADAS ═══════════════════════════════
   Fonte ÚNICA dos textos de interface da plataforma. Hoje só inglês ('en'); para adicionar outro
   idioma no futuro, basta acrescentar um bloco irmão e trocar window.LANG.

   Uso:
   - JS: t('versionHistory.restoreConfirm')  ou  t('presence.manyHere', { n: 3 })
   - HTML estático: <button data-i18n="versionHistory.historyBtn"
                            data-i18n-title="versionHistory.historyBtnTitle">History</button>
     (o texto em inglês fica no próprio HTML como default — sem flash — e applyI18n() reconfirma/
      permite trocar de idioma depois.)

   Interpolação: {name}, {n}, ... são substituídos pelos valores passados em params.
   Regra: só a parte FIXA do texto vem daqui; dado do usuário (nome, label, nome de projeto) é
   passado como param e nunca é traduzido. */

(function () {
  window.LANG = window.LANG || 'en';

  window.STR = {
    en: {
      versionHistory: {
        historyBtn: 'History',
        historyBtnTitle: 'Version history — restore an earlier point or save a backup',
        modalTitle: 'Version history',
        saveBackupBtn: 'Save backup',
        loading: 'Loading…',
        unavailable: 'History unavailable (the project_versions table hasn’t been created in the database yet).',
        empty: 'No versions saved yet. Every time you save, an automatic version is kept (at most one every 5 minutes); use “Save backup” to mark an important point.',
        tagBackup: 'Backup',
        tagAuto: 'Auto',
        restoreBtn: 'Restore',
        restoreConfirm: 'Restore this version? The current state is saved as a backup first, so you can always come back. Newer content from other people is not deleted.',
        restored: 'Version restored. Reopen the item to see the result.',
        cantLoad: 'Couldn’t load this version.',
        projectNotFound: 'Project not found locally.',
        openToView: 'Open a project to view its history.',
        openToBackup: 'Open a project to save a backup.',
        backupUnavailable: 'Backup unavailable: the project_versions table hasn’t been created in the database yet.',
        backupPrompt: 'Backup name (optional):',
        backupSaved: 'Backup saved.',
        backupFailed: 'Couldn’t save the backup.',
        defaultBackupLabel: 'Manual backup',
        beforeRestoreLabel: 'Before restoring'
      },
      presence: {
        hereNowTitle: '{name} is here now',
        oneHere: '{name} is here',
        manyHere: '{n} people here now'
      },
      sync: {
        mergeNotice: '✓ Synced — a teammate was editing at the same time, so their changes were merged in.'
      }
    }
  };

  // Mapa dos labels-padrão em PT já gravados no banco ANTES da padronização em inglês, pra exibir
  // traduzidos sem reescrever as linhas antigas (edge case do levantamento).
  window.LEGACY_LABEL_MAP = {
    'Antes de restaurar': 'versionHistory.beforeRestoreLabel',
    'Backup manual': 'versionHistory.defaultBackupLabel'
  };

  function _lookup(key) {
    const dict = (window.STR && window.STR[window.LANG]) || {};
    return key.split('.').reduce(function (o, k) { return (o == null ? undefined : o[k]); }, dict);
  }

  window.t = function (key, params) {
    var s = _lookup(key);
    if (s == null) return key; // fallback: mostra a chave em vez de quebrar
    if (params) {
      s = s.replace(/\{(\w+)\}/g, function (m, name) {
        return (params[name] != null) ? params[name] : m;
      });
    }
    return s;
  };

  // Traduz um label de versão que possa ter sido gravado em PT antes da padronização.
  window.displayVersionLabel = function (label) {
    if (!label) return label;
    var key = window.LEGACY_LABEL_MAP[label];
    return key ? window.t(key) : label;
  };

  // Preenche textos/tooltips estáticos marcados com data-i18n / data-i18n-title.
  window.applyI18n = function (root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      var v = window.t(el.getAttribute('data-i18n'));
      if (v) el.textContent = v;
    });
    root.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      var v = window.t(el.getAttribute('data-i18n-title'));
      if (v) el.setAttribute('title', v);
    });
  };

  if (document.readyState !== 'loading') window.applyI18n();
  else document.addEventListener('DOMContentLoaded', function () { window.applyI18n(); });
})();
