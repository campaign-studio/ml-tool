/* ═══════════════════════════════════════════════════════════════════════════════════════════
 * modules/soft-block.js — SOFT BLOCK: restricted edit access, per person, per project.
 *
 * WHAT IT IS
 * A third role in sharing, alongside Editor and Approver. Someone under soft block translates
 * normally (that is what you want from an external translator or partner), but cannot touch the
 * STRUCTURE of the project:
 *   1. images         — can't edit image-row URLs, can't change the image selection
 *   2. rows           — can't add (Re-scan) and can't delete
 *   3. origin HTML    — can't open/save "Edit Tagged HTML", can't edit the Origin column
 *   4. CSV/XLSX upload— a spreadsheet rewrites translations in bulk and can change the structure
 *   5. version restore— swapping the whole project for an older version undoes everything at once
 * Removing a whole LANGUAGE COLUMN is blocked too. It wasn't in the original request, but leaving
 * it open would make the block decorative (delete the column instead of the rows) and the damage
 * is bigger than deleting a single row.
 *
 * WHY "SOFT"
 * It is not read-only — that already exists (_approverMode, from the Approver role). The person
 * keeps writing translations, with the usual autosave, merge and live co-editing. Only structure
 * is locked.
 *
 * SILENT BY DESIGN
 * The blocked person is never TOLD they are blocked: no banner, no toast, no tooltip, and the
 * share notification reads like a normal editor invite. The restricted controls simply are not
 * rendered, so the experience is "open it and translate". softBlockDeny() therefore blocks
 * quietly — it returns true and says nothing.
 *
 * HOW IT IS STORED
 * p.softBlocked = ['email@x', ...] (lowercase). The person STAYS in p.sharedWith — they do have
 * access, they are just restricted. Storing it as a list of e-mails (instead of a role field
 * inside sharedWith) gives concurrent merge for free: 'softBlocked' is in _BODY_MERGE_SET_LIST
 * and is merged by UNION, exactly like approvers/sharedWith, so two owners editing sharing at the
 * same time never overwrite each other.
 *
 * REAL GUARD, NOT JUST A HIDDEN BUTTON
 * softBlockApplyUi() hides the controls, but every ACTION also calls softBlockDeny() on its first
 * line. Without that, the console alone would defeat the block — the same lesson setMemberRole
 * already records: a permission check has to be a real guard, not just a hidden button.
 *
 * Depends (at runtime) on index.html globals: currentProjectId, projGetAll, authCurrentUser.
 * As in live-coedit.js: top-level let/const bindings (currentProjectId, _campaign) are NOT on
 * window — they must be read by identifier, guarded with typeof.
 * ═══════════════════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const gProjId = () => (typeof currentProjectId !== 'undefined' ? currentProjectId : null);
  const fn = (name) => (typeof global[name] === 'function' ? global[name] : null);

  const _lc = (s) => String(s || '').toLowerCase();

  // Short memo: isSoftBlocked() is consulted on every keystroke in an image cell, and projGetAll()
  // JSON.parses the whole store. 2s is short enough for a role change to show up almost at once,
  // and long enough to stay off the typing path.
  let _memo = { id: null, at: 0, val: false };
  const MEMO_MS = 2000;

  // Is the signed-in person under soft block on THIS project? The owner is never blocked — they
  // are the one applying it.
  function isSoftBlocked(projectId) {
    const id = projectId || gProjId();
    if (!id) return false;
    const now = Date.now();
    if (_memo.id === id && (now - _memo.at) < MEMO_MS) return _memo.val;
    let val = false;
    try {
      const me = fn('authCurrentUser') && global.authCurrentUser();
      const all = fn('projGetAll') ? global.projGetAll() : [];
      const p = all.find(x => x.id === id);
      if (me && p) {
        const isOwner = _lc(p.owner) === _lc(me.email);
        val = !isOwner && (p.softBlocked || []).some(e => _lc(e) === _lc(me.email));
      }
    } catch (e) { val = false; }
    _memo = { id, at: now, val };
    return val;
  }

  // Drop the memo immediately (used when the app itself changes someone's role).
  function softBlockInvalidate() { _memo = { id: null, at: 0, val: false }; }

  // Action gatekeeper: returns TRUE (= blocked) or FALSE (= let it through). Every structural
  // action calls this on its first line. Deliberately SILENT — see "silent by design" above.
  function softBlockDeny() {
    return isSoftBlocked();
  }

  /* ── UI: don't render what can't be used (the real guard lives in the actions) ───────────── */

  // Called after every grid render (buildTable / renderCampaignGrid) and when opening the editor.
  function softBlockApplyUi() {
    const on = isSoftBlocked();
    document.body.classList.toggle('soft-blocked', on);
    if (!on) return;
    // Image cells: genuinely readonly. The image input is a plain <input>, so it does not go
    // through the readonly-textarea dance the grid controller uses for translation cells.
    // No title/tooltip here on purpose — it would announce the block.
    document.querySelectorAll('#gstb input.img-url, #campGstb input.img-url').forEach(el => {
      el.readOnly = true;
    });
  }

  /* ── Sharing role ──────────────────────────────────────────────────────────────────────── */

  // Effective role of an e-mail on a project: 'approver' | 'softblock' | 'editor' | null.
  // An approver is never "soft block": they already edit nothing (_approverMode), so the
  // combination would mean nothing — hence the three roles stay mutually exclusive, as before.
  function softBlockRoleOf(p, email) {
    const e = _lc(email);
    if ((p.approvers || []).some(x => _lc(x) === e)) return 'approver';
    const hasAccess = (p.sharedWith || []).some(x => _lc(x) === e);
    if (!hasAccess) return null;
    return (p.softBlocked || []).some(x => _lc(x) === e) ? 'softblock' : 'editor';
  }

  // Applies the chosen role across the project's 3 lists. Takes the project object and mutates it —
  // the caller (setMemberRole) handles pull, permission, persistence and rollback.
  function softBlockApplyRole(p, email, role) {
    const e = _lc(email);
    p.sharedWith  = p.sharedWith  || [];
    p.approvers   = p.approvers   || [];
    p.softBlocked = p.softBlocked || [];
    const drop = (arr) => arr.filter(x => _lc(x) !== e);
    if (role === null) {
      p.sharedWith = drop(p.sharedWith); p.approvers = drop(p.approvers); p.softBlocked = drop(p.softBlocked);
      return;
    }
    if (!p.sharedWith.some(x => _lc(x) === e)) p.sharedWith.push(email);
    p.approvers   = drop(p.approvers);
    p.softBlocked = drop(p.softBlocked);
    if (role === 'approver')       p.approvers.push(email);
    else if (role === 'softblock') p.softBlocked.push(email);
    softBlockInvalidate();
  }

  global.isSoftBlocked       = isSoftBlocked;
  global.softBlockDeny       = softBlockDeny;
  global.softBlockApplyUi    = softBlockApplyUi;
  global.softBlockInvalidate = softBlockInvalidate;
  global.softBlockRoleOf     = softBlockRoleOf;
  global.softBlockApplyRole  = softBlockApplyRole;
})(window);
