export function createState() {
  return {
    raw: null, // { prefectures, visits, activities, pathPoints, frequentPlaces }
    prefGeoJSON: null,
    privacy: true,
    filter: { year: null, month: null },
    tab: 'map',
    history: [{ view: 'national', params: {} }],
    historyIndex: 0,
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

export function navigateTo(state, view, params = {}) {
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push({ view, params });
  state.historyIndex = state.history.length - 1;
}

export function goBack(state) {
  if (canGoBack(state)) state.historyIndex -= 1;
}

export function goForward(state) {
  if (canGoForward(state)) state.historyIndex += 1;
}
