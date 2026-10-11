import './index.css';
import {
  fetchMarkets,
  fetchAllResults,
  fetchMarketHistory,
  getTodayIsoDateStr,
  getYesterdayIsoDateStr,
  getPreviousIsoDateStr,
  extractIsoDate,
  extractResultString,
  formatDbDateToDisplay,
  onRealtimeChange
} from './supabase.js';
import {
  initNotificationUI,
  updateKnownMarkets,
  updateAlertsBadge,
  setNotificationToastHandler
} from './notifications-ui.js';
import {
  checkAndNotifyResultUpdate,
  isSubscribedToMarket,
  toggleMarketSubscription,
  onNotificationChange
} from './notifications.js';

const nowInitial = new Date();
const initialCurrentYM = `${nowInitial.getFullYear()}-${String(nowInitial.getMonth() + 1).padStart(2, '0')}`;

let allMarkets = [];
let allResults = [];
let currentMarket = null; // null or market object
let currentViewMode = 'matrix'; // 'matrix' or 'single'
let selectedYearMonth = initialCurrentYM; // 'YYYY-MM' or 'ALL'
let selectedSpecificDate = '';
let searchFilterKeyword = '';
let visibleDateCount = 60;

// Month names
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Escape HTML
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Show Toast
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const bgClass = type === 'error' ? 'bg-rose-900 border-rose-700 text-rose-100' :
                  type === 'success' ? 'bg-emerald-900 border-emerald-700 text-emerald-100' :
                  'bg-slate-900 border-slate-700 text-slate-100';

  toast.className = `p-3 rounded-xl shadow-xl border text-xs font-bold pointer-events-auto transition-all transform duration-200 flex items-center justify-between gap-2 ${bgClass}`;
  toast.innerHTML = `
    <span>${escapeHtml(message)}</span>
    <button class="text-slate-400 hover:text-white font-bold ml-2 cursor-pointer">&times;</button>
  `;

  toast.querySelector('button').onclick = () => toast.remove();
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Format date helper with Day of week
function getDayNameForDate(dateIso) {
  const cleanIso = extractIsoDate(dateIso);
  if (!cleanIso || !/^\d{4}-\d{2}-\d{2}$/.test(cleanIso)) return '';
  const [y, m, d] = cleanIso.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  return DAY_NAMES[dateObj.getDay()] || '';
}

// Populate Month dropdown dynamically based on actual dates in database
function populateMonthDropdown() {
  const monthSelect = document.getElementById('filter-month-select');
  if (!monthSelect) return;

  const uniqueMonths = new Set();

  // Add months from allResults
  if (Array.isArray(allResults)) {
    allResults.forEach(item => {
      const d = extractIsoDate(item.result_date);
      if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
        uniqueMonths.add(d.substring(0, 7));
      }
    });
  }

  // Also include current month
  const now = new Date();
  const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  uniqueMonths.add(currentYM);

  const sortedMonths = Array.from(uniqueMonths).sort((a, b) => b.localeCompare(a));

  monthSelect.innerHTML = '';

  const allOpt = document.createElement('option');
  allOpt.value = 'ALL';
  allOpt.textContent = '🌟 All Time (Full History)';
  monthSelect.appendChild(allOpt);

  sortedMonths.forEach(ym => {
    const [yStr, mStr] = ym.split('-');
    const mNum = parseInt(mStr, 10) - 1;
    const opt = document.createElement('option');
    opt.value = ym;
    opt.textContent = `📅 ${MONTH_NAMES[mNum] || mStr} ${yStr}`;
    monthSelect.appendChild(opt);
  });

  monthSelect.value = selectedYearMonth;
}

// Build consolidated Result Lookup Map from all_results table records AND allMarkets live values
function buildConsolidatedResultMap() {
  const map = new Map();
  const todayIso = getTodayIsoDateStr();
  const yesterdayIso = getYesterdayIsoDateStr();

  // Helper to index multiple keys for robust matching
  const setIndex = (name, marketId, dateStr, val) => {
    if (!val || val === 'XX' || val === '--') return;
    const cleanVal = extractResultString(val);
    if (!cleanVal || cleanVal === 'XX' || cleanVal === '--') return;

    if (name) {
      const cleanName = String(name).trim().toLowerCase();
      map.set(`${cleanName}|${dateStr}`, cleanVal);
      // Slug version: "new gaziabad" -> "new-gaziabad"
      const slug = cleanName.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (slug) map.set(`${slug}|${dateStr}`, cleanVal);
      // Stripped alphanumeric: "newgaziabad"
      const stripped = cleanName.replace(/[^a-z0-9]/g, '');
      if (stripped) map.set(`${stripped}|${dateStr}`, cleanVal);

      // Special alias mappings (e.g. gali, disawer <-> disawar, ghaziabad <-> gaziabad)
      if (cleanName.includes('gali')) {
        map.set(`gali|${dateStr}`, cleanVal);
      }
      if (cleanName.includes('disaw') || cleanName.includes('desaw')) {
        map.set(`disawer|${dateStr}`, cleanVal);
        map.set(`disawar|${dateStr}`, cleanVal);
      }
      if (cleanName.includes('gaziabad') || cleanName.includes('ghaziabad')) {
        if (cleanName.includes('new')) {
          map.set(`new-gaziabad|${dateStr}`, cleanVal);
          map.set(`new-ghaziabad|${dateStr}`, cleanVal);
        } else {
          map.set(`gaziabad|${dateStr}`, cleanVal);
          map.set(`ghaziabad|${dateStr}`, cleanVal);
        }
      }
    }
    if (marketId) {
      map.set(`id:${String(marketId).trim()}|${dateStr}`, cleanVal);
    }
  };

  // 1. Read from allResults table records
  if (Array.isArray(allResults)) {
    allResults.forEach(item => {
      const normDate = extractIsoDate(item.result_date);
      const rawRes = (item.result !== undefined && item.result !== null) ? item.result : item.result_number;
      const resStr = extractResultString(rawRes);
      if (normDate && resStr && resStr !== 'XX' && resStr !== '--') {
        setIndex(item.market_name, item.market_id, normDate, resStr);
      }
    });
  }

  // 2. ALSO merge live values from allMarkets (which are shown on the Home Page!)
  // This guarantees that any number declared for Gali, New Ghaziabad, etc.
  // that appears on the Home Page is ALWAYS present in the Record Chart and Matrix Grid!
  if (Array.isArray(allMarkets)) {
    allMarkets.forEach(m => {
      // Today's number
      const todayNum = extractResultString(m.today_number !== undefined ? m.today_number : m.first_number);
      if (todayNum && todayNum !== 'XX' && todayNum !== '--') {
        setIndex(m.market_name, m.id, todayIso, todayNum);
      }

      // Yesterday's number
      const yestNum = extractResultString(m.yesterday_number !== undefined ? m.yesterday_number : m.second_number);
      if (yestNum && yestNum !== 'XX' && yestNum !== '--') {
        setIndex(m.market_name, m.id, yesterdayIso, yestNum);
      }
    });
  }

  return map;
}

// Universal lookup for a market result on a given date (guaranteeing Gali and all markets match)
function lookupMarketResult(resultMap, market, dateIso) {
  if (!market || !dateIso) return null;
  const todayIso = getTodayIsoDateStr();
  const yesterdayIso = getYesterdayIsoDateStr();
  const name = (market.market_name || '').trim().toLowerCase();
  const id = market.id ? `id:${String(market.id).trim()}` : '';
  const slug = name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const stripped = name.replace(/[^a-z0-9]/g, '');

  // 1. Check direct name match
  let val = resultMap.get(`${name}|${dateIso}`);
  if (val && val !== 'XX' && val !== '--') return val;

  // 2. Check slug / stripped match
  if (slug) {
    val = resultMap.get(`${slug}|${dateIso}`);
    if (val && val !== 'XX' && val !== '--') return val;
  }
  if (stripped) {
    val = resultMap.get(`${stripped}|${dateIso}`);
    if (val && val !== 'XX' && val !== '--') return val;
  }

  // 3. Check ID match
  if (id) {
    val = resultMap.get(`${id}|${dateIso}`);
    if (val && val !== 'XX' && val !== '--') return val;
  }

  // 4. Special market name aliases (e.g. Gali, Disawer, etc.)
  if (name.includes('gali')) {
    val = resultMap.get(`gali|${dateIso}`);
    if (val && val !== 'XX' && val !== '--') return val;
  }
  if (name.includes('disaw') || name.includes('desaw')) {
    val = resultMap.get(`disawer|${dateIso}`) || resultMap.get(`disawar|${dateIso}`);
    if (val && val !== 'XX' && val !== '--') return val;
  }
  if (name.includes('gaziabad') || name.includes('ghaziabad')) {
    if (name.includes('new')) {
      val = resultMap.get(`new-gaziabad|${dateIso}`) || resultMap.get(`new-ghaziabad|${dateIso}`);
    } else {
      val = resultMap.get(`gaziabad|${dateIso}`) || resultMap.get(`ghaziabad|${dateIso}`);
    }
    if (val && val !== 'XX' && val !== '--') return val;
  }

  // 5. Fallback directly to market object's live numbers (same as home page!)
  if (dateIso === todayIso) {
    const rawToday = market.today_number !== undefined ? market.today_number : market.first_number;
    const tNum = extractResultString(rawToday);
    if (tNum && tNum !== 'XX' && tNum !== '--') return tNum;
  }

  if (dateIso === yesterdayIso) {
    const rawYest = market.yesterday_number !== undefined ? market.yesterday_number : market.second_number;
    const yNum = extractResultString(rawYest);
    if (yNum && yNum !== 'XX' && yNum !== '--') return yNum;
  }

  return null;
}

// Get all unique sorted dates to render based on filters (all dates 1 to 30/31)
function getDatesToRender(resultMap) {
  const dateSet = new Set();
  const todayIso = getTodayIsoDateStr();
  const yesterdayIso = getYesterdayIsoDateStr();

  if (selectedSpecificDate) {
    return [selectedSpecificDate];
  }

  if (selectedYearMonth !== 'ALL' && /^\d{4}-\d{2}$/.test(selectedYearMonth)) {
    const [y, m] = selectedYearMonth.split('-').map(Number);
    const totalDays = new Date(y, m, 0).getDate();
    for (let d = 1; d <= totalDays; d++) {
      const dStr = String(d).padStart(2, '0');
      dateSet.add(`${selectedYearMonth}-${dStr}`);
    }
  } else {
    // "ALL" - Gather full days (1 to 30/31) for current month and all recorded months
    const uniqueMonths = new Set();
    const now = new Date();
    const curYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    uniqueMonths.add(curYM);
    if (todayIso) uniqueMonths.add(todayIso.substring(0, 7));

    if (Array.isArray(allResults)) {
      allResults.forEach(item => {
        const d = extractIsoDate(item.result_date);
        if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
          uniqueMonths.add(d.substring(0, 7));
        }
      });
    }

    uniqueMonths.forEach(ym => {
      const [y, m] = ym.split('-').map(Number);
      const totalDays = new Date(y, m, 0).getDate();
      for (let d = 1; d <= totalDays; d++) {
        const dStr = String(d).padStart(2, '0');
        dateSet.add(`${ym}-${dStr}`);
      }
    });
  }

  // Always ensure today's date and yesterday's date exist in the set
  if (selectedYearMonth === 'ALL' || (selectedYearMonth && todayIso.startsWith(selectedYearMonth))) {
    dateSet.add(todayIso);
  }
  if (selectedYearMonth === 'ALL' || (selectedYearMonth && yesterdayIso.startsWith(selectedYearMonth))) {
    dateSet.add(yesterdayIso);
  }

  // Sort dates ascending (01 to 30/31)
  return Array.from(dateSet).sort((a, b) => a.localeCompare(b));
}

// Update Top Card Headers & Stats
function renderHeaderCard() {
  const pageTitleEl = document.getElementById('page-market-name');
  const drawTimeEl = document.getElementById('page-draw-time');
  const marketSelect = document.getElementById('market-select');
  const countBadge = document.getElementById('chart-total-count-badge');

  if (countBadge) {
    const totalMarkets = allMarkets.length;
    const totalResults = allResults.length;
    countBadge.textContent = `📊 ${totalMarkets} Active Markets • ${totalResults} Results in DB`;
  }

  if (currentMarket) {
    // Single market mode
    const title = `${currentMarket.market_name} Record Chart`;
    document.title = `${title} – NEW GAZIABAD RESULTS`;

    if (pageTitleEl) pageTitleEl.textContent = title;
    if (drawTimeEl) drawTimeEl.textContent = `Daily Draw Time: ${currentMarket.draw_time || '--'}`;
    if (marketSelect) marketSelect.value = String(currentMarket.id);
  } else {
    // All markets matrix mode
    document.title = `All Markets Record Chart – NEW GAZIABAD RESULTS`;
    if (pageTitleEl) pageTitleEl.textContent = 'All Markets Record Chart';
    if (drawTimeEl) drawTimeEl.textContent = 'Showing complete winning results for all game markets';
    if (marketSelect) marketSelect.value = 'ALL';
  }
}

// ----------------------------------------------------
// 1. RENDER ALL MARKETS MATRIX TABLE
// ----------------------------------------------------
function renderMatrixView() {
  const matrixContainer = document.getElementById('matrix-view-container');
  const singleContainer = document.getElementById('single-view-container');
  const thead = document.getElementById('matrix-table-head');
  const tbody = document.getElementById('matrix-table-body');
  const showingCount = document.getElementById('matrix-showing-count');
  const paginationFooter = document.getElementById('matrix-pagination-footer');
  const loadMoreBtn = document.getElementById('matrix-load-more-btn');
  const matrixHeading = document.getElementById('matrix-heading');

  if (matrixContainer) matrixContainer.classList.remove('hidden');
  if (singleContainer) singleContainer.classList.add('hidden');

  if (!thead || !tbody) return;

  const resultMap = buildConsolidatedResultMap();
  const allDates = getDatesToRender(resultMap);
  const todayIso = getTodayIsoDateStr();

  // Filter markets by search keyword if entered
  let marketsToDisplay = allMarkets;
  if (searchFilterKeyword) {
    const kw = searchFilterKeyword.toLowerCase();
    marketsToDisplay = allMarkets.filter(m => 
      (m.market_name && m.market_name.toLowerCase().includes(kw)) ||
      (m.draw_time && m.draw_time.toLowerCase().includes(kw))
    );
    if (marketsToDisplay.length === 0) marketsToDisplay = allMarkets; // fallback
  }

  // 1. Build Header
  let headHtml = `
    <tr>
      <th class="py-3 px-3.5 text-left sticky left-0 bg-slate-950 z-30 shadow-xs whitespace-nowrap min-w-[110px]">
        Date / Day
      </th>
  `;

  marketsToDisplay.forEach(m => {
    headHtml += `
      <th class="py-3 px-3 text-center whitespace-nowrap min-w-[90px] cursor-pointer hover:text-amber-300 transition-colors" data-market-id="${escapeHtml(m.id)}" title="Click to view full ${escapeHtml(m.market_name)} history">
        <div class="font-black text-xs text-amber-400">${escapeHtml(m.market_name)}</div>
        <div class="text-[10px] text-slate-400 font-semibold lowercase">${escapeHtml(m.draw_time || '')}</div>
      </th>
    `;
  });
  headHtml += `</tr>`;
  thead.innerHTML = headHtml;

  // Attach header click handlers to switch to single market view
  thead.querySelectorAll('[data-market-id]').forEach(th => {
    th.onclick = () => {
      const mid = th.getAttribute('data-market-id');
      const found = allMarkets.find(m => String(m.id) === String(mid));
      if (found) {
        selectMarket(found);
      }
    };
  });

  // 2. Build Rows
  const datesToShow = allDates.slice(0, visibleDateCount);

  if (datesToShow.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="${marketsToDisplay.length + 1}" class="py-12 text-center text-xs font-bold text-slate-400">
          No records found matching the selected filter.
        </td>
      </tr>
    `;
    if (showingCount) showingCount.textContent = '0 Dates';
    if (paginationFooter) paginationFooter.classList.add('hidden');
    return;
  }

  if (showingCount) {
    showingCount.textContent = `Showing ${datesToShow.length} of ${allDates.length} recorded dates (${marketsToDisplay.length} markets)`;
  }

  tbody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  datesToShow.forEach((dateIso, rowIdx) => {
    const isToday = (dateIso === todayIso);
    const isSelectedSpecific = (selectedSpecificDate && dateIso === selectedSpecificDate);
    const displayDate = formatDbDateToDisplay(dateIso);
    const dayName = getDayNameForDate(dateIso);
    const dayShort = dayName ? dayName.substring(0, 3) : '';

    const tr = document.createElement('tr');
    tr.className = isSelectedSpecific
      ? 'bg-amber-950/70 border-y-2 border-amber-400 font-bold'
      : (isToday ? 'bg-amber-950/40 font-bold' : (rowIdx % 2 === 0 ? 'bg-slate-900' : 'bg-slate-950/60'));

    // Sticky Date Column
    let rowHtml = `
      <td class="py-3 px-3.5 sticky left-0 bg-slate-950 z-10 font-bold text-xs whitespace-nowrap border-r border-slate-800">
        <div class="flex items-center gap-1.5">
          <span class="${isToday ? 'text-amber-400 font-black' : 'text-slate-200'}">${displayDate}</span>
          ${isToday ? '<span class="text-[9px] bg-amber-400 text-slate-950 font-black px-1.5 py-0.2 rounded uppercase">Today</span>' : `<span class="text-[10px] text-slate-400 font-medium">${dayShort}</span>`}
        </div>
      </td>
    `;

    // Columns for each market
    marketsToDisplay.forEach(m => {
      let resVal = lookupMarketResult(resultMap, m, dateIso);

      // If no recorded value in map for today, show XX
      if (!resVal && isToday) {
        resVal = 'XX';
      }

      let cellPill = '';
      if (!resVal || resVal === 'XX' || resVal === '--') {
        cellPill = `<span class="inline-block font-mono font-bold text-slate-500 text-xs px-2 py-0.5 rounded bg-slate-900/60">XX</span>`;
      } else {
        const matchesSearch = searchFilterKeyword && resVal.includes(searchFilterKeyword);
        const highlightClass = matchesSearch 
          ? 'bg-amber-300 text-slate-950 ring-2 ring-amber-400 scale-110 font-black' 
          : 'bg-amber-400/90 hover:bg-amber-400 text-slate-950 font-black';

        cellPill = `<span class="inline-block font-mono text-sm px-2.5 py-1 rounded-lg ${highlightClass} shadow-xs transition-transform cursor-pointer" title="${escapeHtml(m.market_name)} (${displayDate}): ${escapeHtml(resVal)}">${escapeHtml(resVal)}</span>`;
      }

      rowHtml += `
        <td class="py-2.5 px-2 text-center whitespace-nowrap border-r border-slate-800/60">
          ${cellPill}
        </td>
      `;
    });

    tr.innerHTML = rowHtml;
    fragment.appendChild(tr);
  });

  tbody.appendChild(fragment);

  // Pagination button
  if (allDates.length > visibleDateCount) {
    if (paginationFooter) paginationFooter.classList.remove('hidden');
    if (loadMoreBtn) {
      loadMoreBtn.textContent = `👇 Load More Historical Dates (${allDates.length - visibleDateCount} remaining)`;
      loadMoreBtn.onclick = () => {
        visibleDateCount += 30;
        renderMatrixView();
      };
    }
  } else {
    if (paginationFooter) paginationFooter.classList.add('hidden');
  }
}

// ----------------------------------------------------
// 2. RENDER SINGLE MARKET DETAILED VIEW
// ----------------------------------------------------
function renderSingleMarketView() {
  const matrixContainer = document.getElementById('matrix-view-container');
  const singleContainer = document.getElementById('single-view-container');
  const tbody = document.getElementById('chart-table-body');
  const showingCount = document.getElementById('single-showing-count');
  const paginationFooter = document.getElementById('chart-footer-pagination');
  const loadMoreBtn = document.getElementById('load-more-records-btn');
  const singleHeading = document.getElementById('single-market-heading');

  if (singleContainer) singleContainer.classList.remove('hidden');
  if (matrixContainer) matrixContainer.classList.add('hidden');

  if (!tbody || !currentMarket) return;

  if (singleHeading) {
    singleHeading.textContent = `${currentMarket.market_name} Complete History`;
  }

  const resultMap = buildConsolidatedResultMap();
  const allDates = getDatesToRender(resultMap);
  const todayIso = getTodayIsoDateStr();
  const mName = currentMarket.market_name.trim().toLowerCase();

  const datesToShow = allDates.slice(0, visibleDateCount);

  if (datesToShow.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="py-12 text-center text-xs font-bold text-slate-400">
          No records found for ${escapeHtml(currentMarket.market_name)} with current filter.
        </td>
      </tr>
    `;
    if (showingCount) showingCount.textContent = '0 Records';
    if (paginationFooter) paginationFooter.classList.add('hidden');
    return;
  }

  if (showingCount) {
    showingCount.textContent = `Showing ${datesToShow.length} of ${allDates.length} recorded days`;
  }

  tbody.innerHTML = '';
  const fragment = document.createDocumentFragment();

  datesToShow.forEach((dateIso, idx) => {
    const isToday = (dateIso === todayIso);
    const isSelectedSpecific = (selectedSpecificDate && dateIso === selectedSpecificDate);
    const displayDate = formatDbDateToDisplay(dateIso);
    const dayName = getDayNameForDate(dateIso);

    let resultVal = lookupMarketResult(resultMap, currentMarket, dateIso);
    if (!resultVal && isToday) {
      resultVal = 'XX';
    }

    const tr = document.createElement('tr');
    tr.className = isSelectedSpecific
      ? 'bg-amber-950/80 border-2 border-amber-400 font-bold'
      : (isToday ? 'bg-amber-950/40 font-bold' : (idx % 2 === 0 ? 'bg-slate-900' : 'bg-slate-950/60'));

    let resultHtml = '';
    if (!resultVal || resultVal === 'XX' || resultVal === '--') {
      resultHtml = `<span class="inline-block px-3 py-1 font-mono font-bold text-slate-500 bg-slate-950/80 rounded-lg border border-slate-800">XX</span>`;
    } else {
      resultHtml = `<span class="inline-block bg-amber-400 hover:bg-amber-300 text-slate-950 font-mono font-black text-base px-4 py-1.5 rounded-xl border border-amber-500 shadow-md">${escapeHtml(resultVal)}</span>`;
    }

    let badgeHtml = '';
    if (isSelectedSpecific) {
      badgeHtml = `<span class="ml-1.5 text-[10px] text-amber-950 bg-amber-400 border border-amber-500 px-2 py-0.5 rounded-md font-black uppercase">Selected</span>`;
    } else if (isToday) {
      badgeHtml = `<span class="ml-1.5 text-[10px] text-slate-950 bg-amber-400 px-2 py-0.5 rounded-md font-black uppercase">Today</span>`;
    }

    tr.innerHTML = `
      <td class="py-3 px-3 sm:px-4 font-bold text-slate-100 text-xs sm:text-sm whitespace-nowrap">
        ${displayDate} ${badgeHtml}
      </td>
      <td class="py-3 px-3 sm:px-4 font-medium text-slate-400 text-xs sm:text-sm whitespace-nowrap hidden sm:table-cell">
        ${dayName}
      </td>
      <td class="py-3 px-3 sm:px-4 font-bold text-amber-300 text-xs sm:text-sm whitespace-nowrap">
        ${escapeHtml(currentMarket.market_name)}
      </td>
      <td class="py-3 px-3 sm:px-4 font-bold text-center text-xs sm:text-sm whitespace-nowrap">
        ${resultHtml}
      </td>
    `;

    fragment.appendChild(tr);
  });

  tbody.appendChild(fragment);

  // Pagination button
  if (allDates.length > visibleDateCount) {
    if (paginationFooter) paginationFooter.classList.remove('hidden');
    if (loadMoreBtn) {
      loadMoreBtn.textContent = `👇 Load More Historical Records (${allDates.length - visibleDateCount} remaining)`;
      loadMoreBtn.onclick = () => {
        visibleDateCount += 30;
        renderSingleMarketView();
      };
    }
  } else {
    if (paginationFooter) paginationFooter.classList.add('hidden');
  }
}

// Render Alert Opt-in Control for Current Market on Chart Page
function renderMarketAlertControl() {
  const container = document.getElementById('chart-market-alert-container');
  if (!container) return;

  if (currentViewMode !== 'single' || !currentMarket || !currentMarket.market_name) {
    container.innerHTML = '';
    return;
  }

  const marketName = currentMarket.market_name;
  const isSub = isSubscribedToMarket(marketName);

  container.innerHTML = `
    <button 
      id="chart-current-market-alert-btn"
      type="button"
      title="${isSub ? `Alerts enabled for ${escapeHtml(marketName)}. Click to turn off.` : `Get alerts when ${escapeHtml(marketName)} result is declared.`}"
      class="inline-flex items-center gap-1.5 text-xs font-black uppercase tracking-wider px-3 py-2 rounded-xl transition-all cursor-pointer shadow-sm ${
        isSub 
          ? 'bg-amber-400 hover:bg-amber-500 text-slate-950 border border-amber-500' 
          : 'bg-slate-900 hover:bg-slate-800 text-amber-300 border border-slate-700'
      }"
    >
      <span>🔔</span>
      <span>${isSub ? 'Alert ON' : `Get Alert for ${escapeHtml(marketName)}`}</span>
    </button>
  `;

  const btn = document.getElementById('chart-current-market-alert-btn');
  if (btn) {
    btn.onclick = async (e) => {
      e.preventDefault();
      btn.disabled = true;
      const res = await toggleMarketSubscription(marketName);
      showToast(res.message, res.success ? (res.subscribed ? 'success' : 'info') : 'error');
      updateAlertsBadge();
      renderMarketAlertControl();
      btn.disabled = false;
    };
  }
}

// Master Render Dispatcher
function renderCurrentView() {
  renderHeaderCard();
  updateViewTabButtons();
  renderMarketAlertControl();

  if (currentViewMode === 'single' && currentMarket) {
    renderSingleMarketView();
  } else {
    renderMatrixView();
  }
}

// Update Active/Inactive state of View Mode Tabs
function updateViewTabButtons() {
  const matrixBtn = document.getElementById('view-mode-matrix-btn');
  const singleBtn = document.getElementById('view-mode-single-btn');

  if (currentViewMode === 'matrix') {
    if (matrixBtn) {
      matrixBtn.className = 'px-3 py-1.5 rounded-lg bg-amber-400 text-slate-950 font-black transition-all shadow-xs cursor-pointer flex items-center gap-1.5';
    }
    if (singleBtn) {
      singleBtn.className = 'px-3 py-1.5 rounded-lg text-slate-400 hover:text-white transition-all cursor-pointer flex items-center gap-1.5';
    }
  } else {
    if (matrixBtn) {
      matrixBtn.className = 'px-3 py-1.5 rounded-lg text-slate-400 hover:text-white transition-all cursor-pointer flex items-center gap-1.5';
    }
    if (singleBtn) {
      singleBtn.className = 'px-3 py-1.5 rounded-lg bg-amber-400 text-slate-950 font-black transition-all shadow-xs cursor-pointer flex items-center gap-1.5';
    }
  }
}

// Helper: Generate clean URL slug for a market (e.g. "DEHLI NOON" -> "dehli-noon")
export function getMarketSlug(marketName) {
  if (!marketName) return '';
  return String(marketName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Helper: Match market from either pathname (e.g. /disawer) or query params
export function findMarketFromPathOrQuery(markets, pathname, queryMarketName, queryMarketId) {
  if (!markets || markets.length === 0) return null;

  if (queryMarketId) {
    const found = markets.find(m => String(m.id) === String(queryMarketId));
    if (found) return found;
  }

  let pathSlug = '';
  if (pathname && pathname !== '/' && pathname !== '/chart.html' && pathname !== '/chart') {
    const cleanPath = pathname.replace(/^\/+|\/+$/g, '').replace(/\.html$/i, '');
    if (cleanPath.startsWith('chart/')) {
      pathSlug = cleanPath.substring(6);
    } else {
      pathSlug = cleanPath;
    }
  }

  const rawCandidate = (pathSlug || queryMarketName || '').trim();
  if (!rawCandidate) return null;

  const decoded = decodeURIComponent(rawCandidate).trim().toLowerCase();
  const normalizedCandidateSlug = decoded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const strippedCandidate = decoded.replace(/[^a-z0-9]/g, '');

  // Exact or slug match
  for (const m of markets) {
    if (!m.market_name) continue;
    const nameLower = m.market_name.trim().toLowerCase();
    const marketSlug = nameLower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const marketStripped = nameLower.replace(/[^a-z0-9]/g, '');

    if (nameLower === decoded || marketSlug === normalizedCandidateSlug || marketStripped === strippedCandidate) {
      return m;
    }
  }

  // Synonym / fuzzy match:
  // e.g. "delhi" vs "dehli", "ghaziabad" vs "gaziabad", "disawar" vs "disawer"
  for (const m of markets) {
    if (!m.market_name) continue;
    const nameLower = m.market_name.trim().toLowerCase();

    // Ghaziabad / Gaziabad
    const candG = strippedCandidate.replace(/ghaziabad/g, 'gaziabad');
    const mG = nameLower.replace(/[^a-z0-9]/g, '').replace(/ghaziabad/g, 'gaziabad');
    if (candG && candG === mG) return m;

    // Delhi / Dehli
    const candD = strippedCandidate.replace(/dehli/g, 'delhi');
    const mD = nameLower.replace(/[^a-z0-9]/g, '').replace(/dehli/g, 'delhi');
    if (candD && candD === mD) return m;

    // Disawer / Disawar
    const candDis = strippedCandidate.replace(/disawar/g, 'disawer');
    const mDis = nameLower.replace(/[^a-z0-9]/g, '').replace(/disawar/g, 'disawer');
    if (candDis && candDis === mDis) return m;
  }

  return null;
}

// Select Market Helper
function selectMarket(market, updateHistory = true) {
  currentMarket = market;
  currentViewMode = market ? 'single' : 'matrix';

  if (updateHistory) {
    if (market) {
      const slug = getMarketSlug(market.market_name);
      window.history.pushState({}, '', `/${slug}`);
    } else {
      window.history.pushState({}, '', '/chart');
    }
  }

  visibleDateCount = 40;
  renderCurrentView();
}

// Setup Event Listeners
function setupEventListeners() {
  const marketSelect = document.getElementById('market-select');
  const monthSelect = document.getElementById('filter-month-select');
  const dateInput = document.getElementById('filter-date-input');
  const searchInput = document.getElementById('filter-search-input');
  const clearBtn = document.getElementById('btn-clear-filters');
  const refreshBtn = document.getElementById('chart-refresh-btn');
  const retryBtn = document.getElementById('retry-connection-btn');
  const matrixTabBtn = document.getElementById('view-mode-matrix-btn');
  const singleTabBtn = document.getElementById('view-mode-single-btn');

  // Mode Tabs
  if (matrixTabBtn) {
    matrixTabBtn.addEventListener('click', () => {
      selectMarket(null);
    });
  }

  if (singleTabBtn) {
    singleTabBtn.addEventListener('click', () => {
      if (!currentMarket && allMarkets.length > 0) {
        selectMarket(allMarkets[0]);
      } else if (currentMarket) {
        selectMarket(currentMarket);
      }
    });
  }

  // Market Select Dropdown
  if (marketSelect) {
    marketSelect.addEventListener('change', () => {
      const selectedVal = marketSelect.value;
      if (selectedVal === 'ALL') {
        selectMarket(null);
      } else {
        const found = allMarkets.find(m => String(m.id) === String(selectedVal));
        if (found) {
          selectMarket(found);
        }
      }
    });
  }

  // Month Select Dropdown
  if (monthSelect) {
    monthSelect.addEventListener('change', () => {
      selectedYearMonth = monthSelect.value;
      selectedSpecificDate = '';
      if (dateInput) dateInput.value = '';
      visibleDateCount = 40;
      renderCurrentView();
    });
  }

  // Specific Date Input
  if (dateInput) {
    dateInput.addEventListener('change', () => {
      if (dateInput.value) {
        selectedSpecificDate = dateInput.value;
      } else {
        selectedSpecificDate = '';
      }
      renderCurrentView();
    });
  }

  // Search Filter Input
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchFilterKeyword = e.target.value.trim();
      renderCurrentView();
    });
  }

  // Clear Filters
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      selectedYearMonth = initialCurrentYM;
      selectedSpecificDate = '';
      searchFilterKeyword = '';
      if (monthSelect) monthSelect.value = initialCurrentYM;
      if (dateInput) dateInput.value = '';
      if (searchInput) searchInput.value = '';
      visibleDateCount = 60;
      renderCurrentView();
      showToast('Filters reset to current month (1-30)', 'info');
    });
  }

  // Live Refresh Button
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const icon = document.getElementById('refresh-icon');
      if (icon) icon.classList.add('animate-spin');
      try {
        const [freshMarkets, freshResults] = await Promise.all([
          fetchMarkets(),
          fetchAllResults()
        ]);
        allMarkets = freshMarkets || [];
        allResults = freshResults || [];

        if (currentMarket) {
          const updated = allMarkets.find(m => String(m.id) === String(currentMarket.id) || m.market_name.toLowerCase() === currentMarket.market_name.toLowerCase());
          if (updated) currentMarket = updated;
        }

        populateMonthDropdown();
        renderCurrentView();
        showToast('⚡ Live records refreshed successfully!', 'success');
      } catch (err) {
        showToast('Failed to refresh data', 'error');
      } finally {
        if (icon) icon.classList.remove('animate-spin');
      }
    });
  }

  // Network listeners
  const offlineBanner = document.getElementById('offline-banner');
  const updateOnlineStatus = () => {
    if (!navigator.onLine) {
      if (offlineBanner) offlineBanner.classList.remove('hidden');
    } else {
      if (offlineBanner) offlineBanner.classList.add('hidden');
    }
  };

  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();

  // Browser Navigation Back/Forward
  window.addEventListener('popstate', () => {
    const params = new URLSearchParams(window.location.search);
    const matched = findMarketFromPathOrQuery(
      allMarkets,
      window.location.pathname,
      params.get('market'),
      params.get('id')
    );
    selectMarket(matched, false);
  });

  // Handle Quick Market Link clicks without full refresh when staying on chart
  document.querySelectorAll('a[href^="/"]').forEach(a => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('/#') || href === '/' || href.includes('.js') || href.includes('.css')) return;
    if (href.startsWith('/new-ghaziabad.html')) return;

    a.addEventListener('click', (e) => {
      // If clicking chart link while on chart page
      if (href === '/chart' || href === '/chart.html') {
        e.preventDefault();
        selectMarket(null);
      } else {
        const cleanSlug = href.replace(/^\/+|\/+$/g, '');
        const found = findMarketFromPathOrQuery(allMarkets, href, cleanSlug, null);
        if (found) {
          e.preventDefault();
          selectMarket(found);
        }
      }
    });
  });

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      window.location.reload();
    });
  }

  // Supabase Realtime Subscription
  onRealtimeChange((payload) => {
    if (!payload || !payload.record) return;
    console.log('⚡ Realtime update on Record Chart page:', payload);
    const rec = payload.record;

    if (payload.table === 'all_results' || payload.table === 'daily_results') {
      const normDate = extractIsoDate(rec.result_date);
      const rawRes = (rec.result !== undefined && rec.result !== null) ? rec.result : rec.result_number;
      const resStr = extractResultString(rawRes);

      if (normDate && resStr && rec.market_name) {
        const existingIdx = allResults.findIndex(r => 
          (r.id && String(r.id) === String(rec.id)) ||
          (r.market_name && r.market_name.trim().toLowerCase() === rec.market_name.trim().toLowerCase() && extractIsoDate(r.result_date) === normDate)
        );

        const normalizedItem = {
          id: rec.id,
          market_id: rec.market_id,
          market_name: rec.market_name.trim(),
          result_date: normDate,
          result: resStr,
          result_number: resStr,
          draw_time: rec.draw_time
        };

        if (existingIdx !== -1) {
          allResults[existingIdx] = normalizedItem;
        } else {
          allResults.unshift(normalizedItem);
        }

        if (resStr && resStr !== 'XX' && resStr !== '--') {
          checkAndNotifyResultUpdate(rec.market_name, resStr, rec.draw_time, normDate);
        }

        populateMonthDropdown();
        renderCurrentView();
        showToast(`⚡ New record received for ${rec.market_name}: ${resStr}`, 'info');
      }
    } else if (payload.table === 'results') {
      const mIdx = allMarkets.findIndex(m => String(m.id) === String(rec.id));
      if (mIdx !== -1) {
        allMarkets[mIdx] = rec;
      } else {
        allMarkets.push(rec);
      }
      if (currentMarket && String(currentMarket.id) === String(rec.id)) {
        currentMarket = rec;
      }

      const todayStr = extractResultString(rec.today_number);
      if (todayStr && todayStr !== 'XX' && todayStr !== '--') {
        checkAndNotifyResultUpdate(rec.market_name, todayStr, rec.draw_time, getTodayIsoDateStr());
      }

      updateKnownMarkets(allMarkets);
      renderCurrentView();
    }
  });

  // Setup Fullscreen Mode for All Markets Matrix Chart
  setupMatrixFullscreen();
}

// ----------------------------------------------------
// FULLSCREEN MODE HANDLER FOR ALL MATRIX RECORD CHARTS
// ----------------------------------------------------
function setupMatrixFullscreen() {
  const matrixFullscreenBtn = document.getElementById('matrix-fullscreen-btn');
  const matrixContainer = document.getElementById('matrix-view-container');
  const matrixExpandIcon = document.getElementById('fullscreen-icon-expand');
  const matrixCollapseIcon = document.getElementById('fullscreen-icon-collapse');
  const matrixBtnText = document.getElementById('matrix-fullscreen-btn-text');

  const singleFullscreenBtn = document.getElementById('single-fullscreen-btn');
  const singleContainer = document.getElementById('single-view-container');
  const singleExpandIcon = document.getElementById('single-fullscreen-icon-expand');
  const singleCollapseIcon = document.getElementById('single-fullscreen-icon-collapse');
  const singleBtnText = document.getElementById('single-fullscreen-btn-text');

  let isFullscreen = false;
  let activeTargetContainer = null;

  const updateFullscreenUI = (active, targetContainer) => {
    isFullscreen = active;
    activeTargetContainer = active ? targetContainer : null;

    if (active && targetContainer) {
      targetContainer.classList.add('matrix-fullscreen-active');
      document.body.style.overflow = 'hidden';

      if (targetContainer === matrixContainer && matrixFullscreenBtn) {
        if (matrixExpandIcon) matrixExpandIcon.classList.add('hidden');
        if (matrixCollapseIcon) matrixCollapseIcon.classList.remove('hidden');
        if (matrixBtnText) matrixBtnText.textContent = 'Exit Fullscreen';
        matrixFullscreenBtn.classList.remove('bg-amber-400', 'text-slate-950', 'hover:bg-amber-300', 'border-amber-500');
        matrixFullscreenBtn.classList.add('bg-rose-600', 'text-white', 'hover:bg-rose-500', 'border-rose-500');
      } else if (targetContainer === singleContainer && singleFullscreenBtn) {
        if (singleExpandIcon) singleExpandIcon.classList.add('hidden');
        if (singleCollapseIcon) singleCollapseIcon.classList.remove('hidden');
        if (singleBtnText) singleBtnText.textContent = 'Exit Fullscreen';
        singleFullscreenBtn.classList.remove('bg-amber-400', 'text-slate-950', 'hover:bg-amber-300', 'border-amber-500');
        singleFullscreenBtn.classList.add('bg-rose-600', 'text-white', 'hover:bg-rose-500', 'border-rose-500');
      }
    } else {
      if (matrixContainer) matrixContainer.classList.remove('matrix-fullscreen-active');
      if (singleContainer) singleContainer.classList.remove('matrix-fullscreen-active');
      document.body.style.overflow = '';

      if (matrixFullscreenBtn) {
        if (matrixExpandIcon) matrixExpandIcon.classList.remove('hidden');
        if (matrixCollapseIcon) matrixCollapseIcon.classList.add('hidden');
        if (matrixBtnText) matrixBtnText.textContent = 'Fullscreen Matrix';
        matrixFullscreenBtn.classList.add('bg-amber-400', 'text-slate-950', 'hover:bg-amber-300', 'border-amber-500');
        matrixFullscreenBtn.classList.remove('bg-rose-600', 'text-white', 'hover:bg-rose-500', 'border-rose-500');
      }

      if (singleFullscreenBtn) {
        if (singleExpandIcon) singleExpandIcon.classList.remove('hidden');
        if (singleCollapseIcon) singleCollapseIcon.classList.add('hidden');
        if (singleBtnText) singleBtnText.textContent = 'Fullscreen Chart';
        singleFullscreenBtn.classList.add('bg-amber-400', 'text-slate-950', 'hover:bg-amber-300', 'border-amber-500');
        singleFullscreenBtn.classList.remove('bg-rose-600', 'text-white', 'hover:bg-rose-500', 'border-rose-500');
      }
    }
  };

  const toggleFullscreen = async (target) => {
    const container = target || (currentViewMode === 'single' ? singleContainer : matrixContainer);
    if (!container) return;

    if (!isFullscreen) {
      updateFullscreenUI(true, container);
      // Attempt native requestFullscreen if permitted
      if (container.requestFullscreen && !document.fullscreenElement) {
        try {
          await container.requestFullscreen();
        } catch (e) {
          // Native fullscreen may fail in iframe sandbox; CSS fullscreen handles it smoothly
        }
      }
    } else {
      updateFullscreenUI(false);
      if (document.fullscreenElement && document.exitFullscreen) {
        try {
          await document.exitFullscreen();
        } catch (e) {
          // ignore
        }
      }
    }
  };

  if (matrixFullscreenBtn && matrixContainer) {
    matrixFullscreenBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleFullscreen(matrixContainer);
    });
  }

  if (singleFullscreenBtn && singleContainer) {
    singleFullscreenBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleFullscreen(singleContainer);
    });
  }

  // Listen to native fullscreen changes (e.g. user presses ESC in browser)
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && isFullscreen) {
      updateFullscreenUI(false);
    }
  });

  // Listen to ESC key for CSS fullscreen mode
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFullscreen) {
      toggleFullscreen();
    }
  });

  // Check URL param ?fullscreen=true or #fullscreen
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('fullscreen') === 'true' || window.location.hash === '#fullscreen') {
    setTimeout(() => {
      toggleFullscreen(currentViewMode === 'single' ? singleContainer : matrixContainer);
    }, 200);
  }
}

// Initialize Record Chart Page
export async function initChartPage() {
  setNotificationToastHandler((msg, type) => showToast(msg, type));
  initNotificationUI(allMarkets);
  onNotificationChange(() => {
    renderMarketAlertControl();
    updateAlertsBadge();
  });

  // Parse URL query params
  const urlParams = new URLSearchParams(window.location.search);
  const targetMarketName = urlParams.get('market');
  const targetMarketId = urlParams.get('id');
  const paramDate = urlParams.get('date');

  if (paramDate && /^\d{4}-\d{2}-\d{2}$/.test(paramDate)) {
    selectedSpecificDate = paramDate;
    const dateInput = document.getElementById('filter-date-input');
    if (dateInput) dateInput.value = paramDate;
  }

  try {
    const [markets, historicalResults] = await Promise.all([
      fetchMarkets(),
      fetchAllResults()
    ]);

    allMarkets = markets || [];
    allResults = historicalResults || [];

    updateKnownMarkets(allMarkets);

    // Populate Market Selector Dropdown
    const marketSelect = document.getElementById('market-select');
    if (marketSelect) {
      let optionsHtml = `<option value="ALL">🌟 ALL MARKETS (Combined Matrix)</option>`;
      allMarkets.forEach(m => {
        optionsHtml += `<option value="${escapeHtml(m.id)}">${escapeHtml(m.market_name)} (${escapeHtml(m.draw_time || '')})</option>`;
      });
      marketSelect.innerHTML = optionsHtml;
    }

    // Determine initial view mode from pathname (e.g. /disawer) or query params
    const matchedMarket = findMarketFromPathOrQuery(
      allMarkets,
      window.location.pathname,
      targetMarketName,
      targetMarketId
    );

    if (matchedMarket) {
      currentMarket = matchedMarket;
      currentViewMode = 'single';
    } else {
      currentViewMode = 'matrix';
      currentMarket = null;
    }

    populateMonthDropdown();
    renderCurrentView();
  } catch (err) {
    console.error('Failed to load chart data:', err);
    showToast('Failed to load records from database.', 'error');
  }

  setupEventListeners();
}

// Start on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initChartPage();
});

// Direct execution in case DOM is already loaded
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initChartPage();
}
