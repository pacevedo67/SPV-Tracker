/**
 * Inactivity auto-logout
 * Logs out after TIMEOUT_MS of no user activity.
 * Shows a warning modal WARN_BEFORE_MS before logout.
 *
 * Auto-detects whether the page is a firm session (default) or an investor
 * session (URL path beginning with /investor) and routes the logout call and
 * post-logout redirect accordingly. Both endpoints denylist the JTI server-
 * side, so a stale tab cannot be revived just by going back in history.
 */
(function () {
  const TIMEOUT_MS    = 30 * 60 * 1000; // 30 minutes
  const WARN_BEFORE_MS = 2  * 60 * 1000; //  2 minutes before logout

  const IS_INVESTOR_PAGE = /^\/investor(?:-|\.html|\/|$)/.test(location.pathname);
  const LOGOUT_URL = IS_INVESTOR_PAGE ? '/api/investor/logout' : '/api/logout';
  const REDIRECT_URL = IS_INVESTOR_PAGE ? '/investor.html' : '/';

  let logoutTimer;
  let warnTimer;
  let warningVisible = false;

  // --- Modal markup ---------------------------------------------------------
  const modal = document.createElement('div');
  modal.id = 'inactivity-modal';
  modal.style.cssText = [
    'display:none',
    'position:fixed',
    'inset:0',
    'z-index:9999',
    'background:rgba(0,0,0,.45)',
    'align-items:center',
    'justify-content:center',
  ].join(';');

  modal.innerHTML = `
    <div style="
      background:#fff;
      border-radius:8px;
      padding:32px 28px;
      max-width:380px;
      width:90%;
      box-shadow:0 8px 32px rgba(0,0,0,.18);
      text-align:center;
      font-family:inherit;
    ">
      <p style="margin:0 0 8px;font-size:17px;font-weight:600;color:#111;">
        Still there?
      </p>
      <p style="margin:0 0 24px;font-size:14px;color:#555;">
        You'll be signed out in <strong id="inactivity-countdown">2:00</strong>
        due to inactivity.
      </p>
      <button id="inactivity-stay" style="
        background:#2563eb;
        color:#fff;
        border:none;
        border-radius:6px;
        padding:10px 28px;
        font-size:14px;
        font-weight:600;
        cursor:pointer;
      ">Stay signed in</button>
    </div>`;

  document.addEventListener('DOMContentLoaded', () => {
    document.body.appendChild(modal);
    document.getElementById('inactivity-stay').addEventListener('click', resetTimers);
    startTimers();
  });

  // --- Timer logic ----------------------------------------------------------
  function startTimers() {
    clearTimers();
    warnTimer = setTimeout(showWarning, TIMEOUT_MS - WARN_BEFORE_MS);
    logoutTimer = setTimeout(doLogout, TIMEOUT_MS);
  }

  function clearTimers() {
    clearTimeout(warnTimer);
    clearTimeout(logoutTimer);
    stopCountdown();
  }

  function resetTimers() {
    hideWarning();
    startTimers();
  }

  // --- Activity listeners ---------------------------------------------------
  const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'];

  function onActivity() {
    if (!warningVisible) {
      resetTimers();
    }
  }

  ACTIVITY_EVENTS.forEach(evt =>
    document.addEventListener(evt, onActivity, { passive: true })
  );

  // --- Warning modal --------------------------------------------------------
  let countdownInterval;
  let countdownEnd;

  function showWarning() {
    warningVisible = true;
    countdownEnd = Date.now() + WARN_BEFORE_MS;
    modal.style.display = 'flex';
    updateCountdown();
    countdownInterval = setInterval(updateCountdown, 1000);
  }

  function hideWarning() {
    warningVisible = false;
    modal.style.display = 'none';
    stopCountdown();
  }

  function stopCountdown() {
    clearInterval(countdownInterval);
  }

  function updateCountdown() {
    const remaining = Math.max(0, countdownEnd - Date.now());
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    const el = document.getElementById('inactivity-countdown');
    if (el) el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }

  // --- Logout ---------------------------------------------------------------
  async function doLogout() {
    try {
      await fetch(LOGOUT_URL, { method: 'POST', credentials: 'include' });
    } catch (_) {
      // proceed to redirect regardless
    }
    window.location.href = REDIRECT_URL;
  }
})();
