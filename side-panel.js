// side-panel.js — Feature 6: open Atom.AI as a persistent Chrome side panel
// instead of a popup that dies on the first click away.
//
// The manifest removes `default_popup` and declares `side_panel.default_path`,
// so on Chrome 114+ the toolbar click opens the panel via
// setPanelBehavior({openPanelOnActionClick:true}). On older Chrome the
// sidePanel API does not exist and the click would do NOTHING — so this module
// also restores a popup fallback via chrome.action.setPopup. Pure and
// dependency-injected (pass `chrome`) so the fallback ladder is unit-testable.

export const POPUP_PATH = 'popup.html';

export async function initSidePanel(chromeLike = globalThis.chrome) {
  if (chromeLike?.sidePanel?.setPanelBehavior) {
    try {
      await chromeLike.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      return { mode: 'side-panel' };
    } catch (e) {
      // setPanelBehavior can reject on some Chrome builds even when the API
      // exists. The popup fallback must still engage — a toolbar click that
      // opens nothing is the worst possible outcome.
    }
  }
  if (chromeLike?.action?.setPopup) {
    try {
      await chromeLike.action.setPopup({ popup: POPUP_PATH });
      return { mode: 'popup-fallback' };
    } catch (e) {
      return { mode: 'none', error: e?.message || String(e) };
    }
  }
  return { mode: 'none', error: 'no sidePanel API and no action.setPopup' };
}
