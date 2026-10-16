// Navigation model: a browser-style back/forward history stack. Each entry
// is one "page" — the coverage map's view ('national' | 'prefecture' |
// 'place' + params), the tab shown, and the day-view date open on top of it
// (or null). Tab switches and day-view opens/steps are entries of their own,
// so back/forward walks everything the user did, like a browser.
//
// `scroll` is filled in by state.onLeave (set in app.mjs) when the user
// leaves an entry, and read back when back/forward/history-jump returns to
// it (`state.restoring`), so a returned-to page looks as it was left.

export function createEntry(view, params = {}, { tab = 'map', day = null } = {}) {
  return { view, params, tab, day, scroll: null };
}

export function createState() {
  return {
    raw: null, // { prefectures, visits, activities, pathPoints, frequentPlaces }
    prefGeoJSON: null,
    photosOnlyMode: false, // issue #21: true when raw is app.mjs's openPhotosOnly() stub, not a real parsed timeline
    privacy: true,
    filter: { year: null, month: null },
    tab: 'map',
    history: [createEntry('national')],
    historyIndex: 0,
    restoring: false, // true right after back/forward/goTo, until the next render consumes it
    onLeave: null,
  };
}

export function currentView(state) {
  return state.history[state.historyIndex];
}

export function canGoBack(state) {
  return state.historyIndex > 0;
}

export function canGoForward(state) {
  return state.historyIndex < state.history.length - 1;
}

function leave(state) {
  if (state.onLeave) state.onLeave(currentView(state));
}

function arrive(state, restoring) {
  state.tab = currentView(state).tab;
  state.restoring = restoring;
}

// Pushes a new page, dropping any forward entries. `tab` defaults to the
// coverage map, since that's where every view/params page is shown.
export function navigateTo(state, view, params = {}, { tab = 'map', day = null } = {}) {
  leave(state);
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(createEntry(view, params, { tab, day }));
  state.historyIndex = state.history.length - 1;
  arrive(state, false);
}

// Same map view, another tab and/or day view on top (tab switch, day view).
export function navigateWithin(state, { tab = currentView(state).tab, day = null } = {}) {
  const { view, params } = currentView(state);
  navigateTo(state, view, params, { tab, day });
}

// Starts a fresh history with one page (new file, period/privacy change).
export function resetHistory(state, entry = createEntry('national', {}, { tab: state.tab })) {
  state.history = [entry];
  state.historyIndex = 0;
  arrive(state, false);
}

export function goTo(state, index) {
  if (index < 0 || index >= state.history.length || index === state.historyIndex) return;
  leave(state);
  state.historyIndex = index;
  arrive(state, true);
}

export function goBack(state) {
  if (canGoBack(state)) goTo(state, state.historyIndex - 1);
}

export function goForward(state) {
  if (canGoForward(state)) goTo(state, state.historyIndex + 1);
}

// The entry the day view (if any) sits on: same page with no day open.
export function isSamePageWithoutDay(a, b) {
  return a.view === b.view && a.tab === b.tab && JSON.stringify(a.params) === JSON.stringify(b.params) && !a.day;
}
