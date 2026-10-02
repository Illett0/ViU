// Month-by-month timelapse playback of the 制覇マップ.

import { el, state } from './context.mjs';
import { getDerived, render } from './app.mjs';

export function getTimelapseSteps() {
  const keys = new Set();
  for (const v of state.raw.visits) if (v.year) keys.add(v.year + '-' + String(v.month).padStart(2, '0'));
  for (const p of state.raw.pathPoints) if (p[4]) keys.add(p[4] + '-' + String(p[5]).padStart(2, '0'));
  return [...keys].sort().map((k) => {
    const [y, m] = k.split('-');
    return { year: Number(y), month: Number(m) };
  });
}

export function startTimelapse() {
  const steps = getTimelapseSteps();
  if (steps.length === 0) return;
  state.timelapse.playing = true;
  state.timelapse.steps = steps;
  state.timelapse.index = 0;
  el.btnTimelapsePlay.innerHTML = '&#9208;';
  el.timelapseOverlay.hidden = false;
  tickTimelapse();
}

export function tickTimelapse() {
  if (!state.timelapse.playing) return;
  const step = state.timelapse.steps[state.timelapse.index];
  state.filter.year = step.year;
  state.filter.month = step.month;
  el.filterYear.value = String(step.year);
  el.filterMonth.value = String(step.month);
  render();

  const derived = getDerived();
  const count =
    state.granularity === 'municipality'
      ? [...derived.muniAggregates.values()].filter((e) => e.stayCount > 0).length
      : [...derived.periodAggregates.values()].filter((e) => e.stayCount > 0 || e.firstEpoch != null).length;
  el.timelapsePeriod.textContent = `${step.year}年${step.month}月`;
  el.timelapseCount.textContent = `${state.granularity === 'municipality' ? '市区町村' : '都道府県'} ${count} 件`;

  state.timelapse.index += 1;
  if (state.timelapse.index >= state.timelapse.steps.length) {
    state.timelapse.playing = false;
    el.btnTimelapsePlay.innerHTML = '&#9654;';
    return;
  }
  state.timelapse.timer = setTimeout(tickTimelapse, 500);
}

export function stopTimelapse() {
  state.timelapse.playing = false;
  if (state.timelapse.timer) clearTimeout(state.timelapse.timer);
  state.timelapse.timer = null;
  el.btnTimelapsePlay.innerHTML = '&#9654;';
}

export function resetTimelapse() {
  stopTimelapse();
  state.filter.year = null;
  state.filter.month = null;
  el.filterYear.value = '';
  el.filterMonth.value = '';
  el.timelapseOverlay.hidden = true;
  render();
}

export function wireTimelapse() {
  el.btnTimelapsePlay.addEventListener('click', () => {
    if (state.timelapse.playing) stopTimelapse();
    else startTimelapse();
  });
  el.btnTimelapseReset.addEventListener('click', resetTimelapse);
}
