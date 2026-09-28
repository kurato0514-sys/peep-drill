// ぴーぷくんの呼吸ドリル
// 無料データ: data/free.json
// アプリの合言葉: data/paid.enc（問題集300問＋暗記カード）
// 記事の合言葉: data/articles.enc（章ごと、またはマガジンで20章まとめて。記事の問題30問＋カード30枚）
const $ = (s, el = document) => el.querySelector(s);
// 「出さない」ために null を渡した部分が、画面に「null」と出ないようにする
const nativeAppend = Element.prototype.append;
Element.prototype.append = function (...items) { return nativeAppend.apply(this, items.filter(x => x != null)); };
const view = $('#view');
const titleEl = $('#title');
const backBtn = $('#back');

const APP_TITLE = 'ぴーぷくんの呼吸ドリル';
const STORE_KEY = 'peep-drill-v1';
const PASS_KEY = 'peep-drill-pass'; // 入れた合言葉の一覧（JSONの配列）
const GRADUATE = 0.9; // 正解率90%以上で卒業
const RECENT = 15; // 分野の正解率は、直近15回で計算する（1項目30問の半周分。伸びが早く数字に出る）
const FREE_OWN_QUESTIONS = 5; // 合言葉なしで作れる自作問題の数
const FREE_OWN_CARDS = 10; // 合言葉なしで作れる自作カードの数
const CHAPTERS = [
  '01 呼吸療法総論',
  '02 呼吸管理に必要な解剖',
  '03 呼吸管理に必要な生理',
  '04 血液ガスの解釈',
  '05 呼吸機能とその検査法',
  '06 胸部の画像診断',
  '07 呼吸不全の病態と管理',
  '08 薬物療法',
  '09 呼吸リハビリテーション',
  '10 吸入療法',
  '11 酸素療法',
  '12 人工呼吸器の基本構造と保守および医療ガス',
  '13 気道確保と気道管理',
  '14 人工呼吸〜換気モードとその適応・離脱',
  '15 NPPVとその管理法',
  '16 開胸・開腹手術後の肺合併症',
  '17 新生児・小児の呼吸管理',
  '18 人工呼吸中のモニター',
  '19 人工呼吸中の集中治療',
  '20 在宅人工呼吸'];

const HELLO = [
  '今日も圧をかけておきますぴーぷ',
  '寝落ちする前に、1枚だけでもめくるといいですぴーぷ',
  'わかったふりは、ここでは通用しないですぴーぷ',
  '正解率は、ちゃんと記録しておきますぴーぷ',
  '90%を超えた分野は、卒業でいいですぴーぷ',
];
const PEEP_RESULT = [
  [0.9, '合格ラインの上ですぴーぷ。この分野は卒業でいいですぴーぷ'],
  [0.7, 'あと少しですぴーぷ。間違えたところだけ、もう1周ですぴーぷ'],
  [0.4, 'わかったふり、してませんでしたぴーぷ？'],
  [0, '1回目のすーさんと同じ匂いがしますぴーぷ'],
];

// ---------- 保存（端末の中だけ。消えても動くように） ----------
function load() {
  let st;
  try { st = JSON.parse(localStorage.getItem(STORE_KEY)); } catch {}
  return normalizeState(st);
}
function normalizeState(st) {
  st = st && typeof st === 'object' ? st : {};
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const arr = v => (Array.isArray(v) ? v : []);
  return {
    cards: obj(st.cards), quiz: obj(st.quiz),
    own: { cards: arr(st.own?.cards), questions: arr(st.own?.questions) },
    settings: st.settings && typeof st.settings === 'object' ? st.settings : null,
    reward: typeof st.reward === 'string' ? st.reward : '',
    exams: arr(st.exams), examRun: st.examRun && Array.isArray(st.examRun.ids) ? st.examRun : null,
    log: arr(st.log).filter(e => e && typeof e.id === 'string'), ownInStats: !!st.ownInStats,
  };
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}
let state = load();

// ---------- データ ----------
let data = { cards: [], questions: [], locked: { cards: {}, questions: {} }, contents: {} };
let unlocked = false; // アプリ（問題集）の合言葉でひらいたか
const artOpen = new Set(); // 記事の合言葉でひらいた章（'01 呼吸療法総論' など）
let passChanged = false; // 年度がかわって合言葉が変わったとき

async function loadFree() {
  const res = await fetch('data/free.json', { cache: 'no-cache' });
  const free = await res.json();
  data.cards = free.cards;
  data.questions = free.questions;
  data.locked = free.locked || { cards: {}, questions: {} };
  data.contents = free.contents || {};
}

const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('nodata');
  return res.json();
}
// 入力のゆれ（全角・大文字小文字・ハイフンや空白）を吸収する。tools/build_app_data.py の norm と同じ処理
const normPass = p => p.normalize('NFKC').replace(/[\s\-－ー‐]/g, '').toLowerCase();
async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normPass(pass)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(salt), iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
const tryDecrypt = (key, iv, blob) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(iv) }, key, b64(blob))
  .then(p => JSON.parse(new TextDecoder().decode(p)), () => null);
// 同じものを2回入れないように、idで重ならない分だけ足す
function addItems(kind, items) {
  const have = new Set(data[kind].map(x => x.id));
  data[kind] = data[kind].concat(items.filter(x => !have.has(x.id)));
}

// 合言葉を1つためす。アプリの合言葉か、記事（章・まとめ）の合言葉か、どちらでもひらける。
// どれにも当たらなければ OperationError を投げる
async function unlock(pass) {
  const [paid, arts] = await Promise.all([getJSON('data/paid.enc'), getJSON('data/articles.enc').catch(() => null)]);
  let hit = false;
  const k1 = await deriveKey(pass, paid.salt, paid.iter);
  const app = await tryDecrypt(k1, paid.iv, paid.data);
  if (app) {
    hit = true;
    if (!unlocked) {
      addItems('cards', app.cards);
      addItems('questions', app.questions);
      data.locked = { cards: {}, questions: {} };
      unlocked = true;
    }
  }
  if (arts && !hit) {
    const k2 = await deriveKey(pass, arts.salt, arts.iter);
    for (const e of arts.entries) {
      const art = await tryDecrypt(k2, e.iv, e.data);
      if (!art) continue;
      hit = true;
      addItems('questions', art.questions.map(q => ({ ...q, art: true })));
      addItems('cards', (art.cards || []).map(c => ({ ...c, art: true })));
      for (const q of art.questions) artOpen.add(q.chapter);
      break;
    }
  }
  if (!hit) throw new DOMException('合言葉がちがう', 'OperationError');
}
function savedPasses() {
  let v = null;
  try { v = localStorage.getItem(PASS_KEY); } catch {}
  if (!v) return [];
  try { const a = JSON.parse(v); if (Array.isArray(a)) return a.filter(x => typeof x === 'string'); } catch {}
  return [v]; // 前の版は合言葉を1つだけ、そのまま保存していた
}
function savePasses(list) {
  try { localStorage.setItem(PASS_KEY, JSON.stringify(uniq(list))); } catch {}
}
const isArticle = x => !!x.art; // 記事の合言葉でひらいた問題・カード

// 1問答えるたびに記録する（分野の正解率は、この記録の直近15回で出す）
function recordAnswer(q, ok) {
  const r = state.quiz[q.id] || { tries: 0, correct: 0 };
  r.tries++; if (ok) r.correct++; r.last = ok; state.quiz[q.id] = r;
  state.log.push({ id: q.id, ok, at: Date.now() });
  if (state.log.length > 5000) state.log = state.log.slice(-5000);
}

// 自作の問題・カードを混ぜた一覧
const allCards = () => data.cards.concat(state.own.cards);
const allQuestions = () => data.questions.concat(state.own.questions);

// ---------- 画面の切り替え ----------
const routes = { home, cards: cardsMenu, quiz: quizMenu, stats, own: ownList };
let stack = [];
function go(name, arg, push = true) {
  if (name !== 'exam_play') { stopExamTimer(); pauseExam(); }
  if (name === 'home') stack = [['home', arg]]; // ホームは常に履歴の一番下
  else if (push) stack.push([name, arg]);
  backBtn.hidden = stack.length <= 1;
  view.innerHTML = '';
  window.scrollTo(0, 0);
  routes[name](arg);
}
backBtn.addEventListener('click', () => {
  stack.pop();
  const [name, arg] = stack[stack.length - 1] || ['home'];
  go(name, arg, false);
});
function setTitle(t) { titleEl.textContent = t || APP_TITLE; document.title = t ? `${t}｜${APP_TITLE}` : APP_TITLE; }
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const uniq = a => [...new Set(a)];

// ---------- ホーム ----------
function home() {
  setTitle();
  view.append($('#tpl-home').content.cloneNode(true));
  $('#peep-hello').textContent = HELLO[Math.floor(Math.random() * HELLO.length)];
  renderReward($('#reward'));
  renderWeak($('#weak'));
  view.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
  const st = $('#unlock-state');
  const form = $('#unlock-form');
  const artList = CHAPTERS.filter(c => artOpen.has(c)).map(c => c.slice(0, 2));
  const lines = [];
  if (unlocked) lines.push('アプリ（問題集300問・暗記カード）：ひらいています');
  if (artList.length) lines.push(`記事の問題・カード：${artList.length === CHAPTERS.length ? '全20章' : artList.join('・') + '章'}がひらいています`);
  if (passChanged) st.before(peepBox('合言葉が変わりましたぴーぷ。購入した記事で新しい合言葉を確かめてくださいぴーぷ'));
  if (!unlocked) {
    const lockedCount = Object.values(data.locked.cards).reduce((a, b) => a + b, 0) + Object.values(data.locked.questions).reduce((a, b) => a + b, 0);
    lines.push(`アプリの合言葉を入れると、残り${lockedCount}件がひらきます。`);
  }
  if (artList.length < CHAPTERS.length) lines.push('記事を買った章は、記事に書いてある合言葉で、その章の記事の問題とカードが足されます。');
  st.replaceChildren(...lines.flatMap((t, i) => (i ? [el('br'), t] : [t])));
  st.after(el('button', { class: 'linkish', onclick: () => go('contents') }, '章ごとの問題・カードの数を見る'));
  form.hidden = unlocked && artList.length === CHAPTERS.length;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const pass = $('#pass').value;
    if (!pass || form.dataset.busy) return;
    form.dataset.busy = '1';
    form.querySelector('button').disabled = true;
    st.textContent = 'たしかめています…';
    try {
      await unlock(pass);
      savePasses(savedPasses().concat(pass));
      passChanged = false;
      if (state.settings) state.settings.chapters = null; // ひらいた分野も選ばれた状態にする
      save();
      go('home', null, false);
    } catch (err) {
      st.textContent = err && err.name === 'OperationError' ? '合言葉がちがうようですぴーぷ' : '通信できませんでした。電波のあるところで、もう一度ためしてください';
      delete form.dataset.busy;
      form.querySelector('button').disabled = false;
    }
  });
}

// ---------- 合格したら（ごほうび）＋全体の正解率 ----------
// 正解率の色：50%以下＝赤、70%以下＝黄、80%未満＝青、80%以上＝緑
function rateLevel(rate) {
  // taunt：ごほうびをあおる／cheer：そのあと応援する（毒舌だけど最後は味方）
  if (rate == null) return { cls: 'lv-none', taunt: 'まず1問解かないと、ごほうびの話は始まりませんぴーぷ', cheer: '1問解いたら、もう昨日の自分より前にいますぴーぷ' };
  const p = rate * 100;
  if (p <= 50) return { cls: 'lv-red', taunt: 'ごほうび、遠のいてますぴーぷ。このままだと落ちるやつですぴーぷ', cheer: '……でも、すーさんも最初はここからでしたぴーぷ。間違えた問題が、いちばんの伸びしろですぴーぷ' };
  if (p <= 70) return { cls: 'lv-yellow', taunt: 'ごほうびはまだお預けですぴーぷ。寝るには早いですぴーぷ', cheer: 'でも半分は超えてますぴーぷ。苦手な分野をもう1周で、景色が変わりますぴーぷ' };
  if (p < 80) return { cls: 'lv-blue', taunt: 'ごほうびまであと少しですぴーぷ。油断したら没収ですぴーぷ', cheer: 'ここまで来た人は強いですぴーぷ。この調子で、最低限の圧はかけておきますぴーぷ' };
  return { cls: 'lv-green', taunt: 'ごほうび、見えてきましたぴーぷ。でも受かるまで買っちゃダメですぴーぷ', cheer: '……よくここまで来ましたぴーぷ。あとは当日まで、この感じを落とさないことですぴーぷ' };
}
function overallRate() {
  let tries = 0, ok = 0;
  for (const c of CHAPTERS) { const s = chapterStats(c); tries += s.tries; ok += s.ok; }
  return { tries, ok, rate: tries ? ok / tries : null };
}
function renderReward(box, editing = false) {
  box.innerHTML = '';
  const o = overallRate();
  const lv = rateLevel(o.rate);
  const pct = o.rate == null ? 0 : Math.round(o.rate * 100);
  const meter = el('button', { class: `rate-ring ${lv.cls}`, style: `--p:${pct}`, onclick: () => go('stats'), 'aria-label': `全体の正解率 ${o.rate == null ? 'まだ解いていない' : pct + '%'}。マイページを開く` },
    el('span', { class: 'ring-in' },
      el('span', { class: 'rate-num' }, o.rate == null ? '—' : `${pct}%`),
      el('span', { class: 'rate-cap' }, o.rate == null ? 'まだ' : `${o.ok}/${o.tries}問`)));
  const main = el('div', { class: 'reward-main' });
  if (state.reward && !editing) {
    main.append(
      el('div', { class: 'reward-label' }, '合格したら'),
      el('div', { class: 'reward-text' }, state.reward),
      el('button', { class: 'linkish', onclick: () => renderReward(box, true) }, '変える'));
    box.append(main, meter, el('div', { class: `reward-peep ${lv.cls}` },
      el('img', { src: 'icon-192.png', alt: '', class: 'peep-ic' }),
      el('div', {}, el('b', {}, 'ぴーぷくん'), el('div', {}, `「${lv.taunt}」`), el('div', { class: 'cheer' }, `「${lv.cheer}」`))));
    return;
  } else {
    const input = el('input', { type: 'text', id: 'reward-input', maxlength: 40, placeholder: '例：PS5を買う／焼肉' });
    input.value = state.reward || '';
    main.append(
      el('div', { class: 'reward-label' }, '合格したら、何をする？'),
      el('p', { class: 'muted' }, 'ごほうびを決めておくと、ここに毎回出ます。すーさんはPS5でした。'),
      el('form', { onsubmit: e => { e.preventDefault(); state.reward = input.value.trim(); save(); renderReward(box); } },
        input, el('button', { class: 'btn', type: 'submit' }, '決める')));
  }
  box.append(main, meter);
}

// ---------- 苦手な分野（正解率が低い2分野） ----------
function renderWeak(box) {
  box.innerHTML = '';
  const rows = CHAPTERS.map(c => ({ c, ...chapterStats(c) })).filter(r => r.n > 0 && r.tries > 0)
    .sort((a, b) => a.rate - b.rate || b.tries - a.tries).slice(0, 2);
  box.append(el('div', { class: 'weak-head' }, el('h2', {}, '苦手な分野'), el('span', { class: 'muted' }, '正解率が低い順')));
  if (!rows.length) {
    box.append(el('p', { class: 'muted' }, '問題を解くと、ここに正解率の低い分野が2つ出ます。'));
    return;
  }
  for (const r of rows) {
    const pct = Math.round(r.rate * 100);
    const lv = rateLevel(r.rate);
    box.append(el('div', { class: `weak-row ${lv.cls}` },
      el('span', { class: 'weak-dot' }),
      el('span', { class: 'weak-name' }, r.c),
      el('span', { class: 'weak-pct' }, `${pct}%`),
      el('button', { class: 'btn weak-go', onclick: () => {
        const qs = allQuestions().filter(q => q.chapter === r.c);
        go('quiz_play', shuffle(qs));
      } }, '解く')));
  }
  if (rows.length === 1) box.append(el('p', { class: 'muted' }, 'ほかの分野も解くと、2つ目が出ます。'));
}

// ---------- 暗記カード ----------
// カードは章ごとに分ける（自作のカードは、自分でつけたカテゴリごと）
const cardKey = c => c.chapter || (c.own ? `✍️${c.category}` : c.category);
function cardCats() {
  const keys = uniq(allCards().map(cardKey));
  const open = CHAPTERS.filter(c => keys.includes(c)).concat(keys.filter(k => !CHAPTERS.includes(k)));
  return { open, locked: CHAPTERS.filter(c => data.locked.cards[c] && !open.includes(c)) };
}
function cardsMenu() {
  setTitle('暗記カード');
  const { open, locked } = cardCats();
  let picked = new Set(open);
  let onlyAgain = false;
  const chips = el('div', { class: 'chips' },
    open.map(c => {
      const n = allCards().filter(x => cardKey(x) === c).length;
      const known = allCards().filter(x => cardKey(x) === c && state.cards[x.id] === 'known').length;
      const b = el('button', { class: 'chip', 'aria-pressed': 'true' }, `${c}（${known}/${n}）`);
      b.addEventListener('click', () => { picked.has(c) ? picked.delete(c) : picked.add(c); b.setAttribute('aria-pressed', picked.has(c)); });
      return b;
    }),
    locked.map(c => el('button', { class: 'chip', disabled: true }, c, el('span', { class: 'lock' }, '🔒')))
  );
  const again = el('button', { class: 'chip', 'aria-pressed': 'false' }, 'まだ覚えていないカードだけ');
  again.addEventListener('click', () => { onlyAgain = !onlyAgain; again.setAttribute('aria-pressed', onlyAgain); });
  view.append(
    el('p', { class: 'muted' }, '分野を選んで、スタート。タップで答えが出ます。'),
    chips,
    el('div', { class: 'chips' }, again),
    el('button', { class: 'btn wide', onclick: () => {
      let deck = allCards().filter(c => picked.has(cardKey(c)));
      if (onlyAgain) deck = deck.filter(c => state.cards[c.id] !== 'known');
      if (!deck.length) return alertInline('カードがありませんぴーぷ');
      go('cards_play', shuffle(deck));
    } }, 'スタート'),
    locked.length ? el('p', { class: 'muted' }, '🔒 の分野は、合言葉でひらきます。') : null,
  );
}
routes.cards_play = deck => {
  setTitle('暗記カード');
  let i = 0, flipped = false, seen = false, knownNow = 0;
  const box = el('div', { class: 'card-box flash' });
  const prog = el('div', { class: 'progress' });
  const row = el('div', { class: 'row' });
  const render = () => {
    const c = deck[i];
    prog.textContent = `${i + 1} / ${deck.length}`;
    box.innerHTML = '';
    box.classList.toggle('is-back', flipped);
    box.append(el('div', { class: 'cat' }, `${isArticle(c) ? '📝記事　' : ''}${cardKey(c)}　${flipped ? 'うら（答え）' : 'おもて（問い）'}`));
    if (!flipped) {
      box.append(el('div', { class: 'face' }, c.front));
    } else {
      box.append(el('div', { class: 'face back' }, c.back));
      if (c.note) box.append(el('div', { class: 'note' }, c.note));
      if (c.source) box.append(el('div', { class: 'src' }, `根拠：${c.source}（${c.checked}確認）`));
      if (c.own) box.append(el('div', { class: 'src' }, '✍️ 自作のカード'));
    }
    box.append(el('div', { class: 'note flip-hint' }, flipped ? 'タップで問いにもどる' : 'タップで答え'));
    row.innerHTML = '';
    if (seen) row.append(
      el('button', { class: 'btn ghost', onclick: () => mark('again') }, 'まだ 😪'),
      el('button', { class: 'btn', onclick: () => mark('known') }, '覚えた ✨'),
    );
  };
  const mark = v => {
    state.cards[deck[i].id] = v; save();
    if (v === 'known') knownNow++;
    i++; flipped = false; seen = false;
    if (i >= deck.length) return done();
    render();
  };
  const done = () => {
    view.innerHTML = '';
    const r = knownNow / deck.length;
    view.append(el('div', { class: 'card-box' },
      el('div', { class: 'big' }, `${knownNow} / ${deck.length}`),
      el('p', { style: 'text-align:center' }, '覚えた枚数'),
      peepBox(r >= 0.9 ? 'ほぼ覚えましたぴーぷ。寝落ちしてもいいですぴーぷ' : '「まだ」のカードだけで、もう1周ですぴーぷ'),
      el('button', { class: 'btn wide', onclick: () => backBtn.click() }, '分野選びにもどる'),
    ));
  };
  box.addEventListener('click', () => { flipped = !flipped; seen = true; render(); });
  view.append(prog, box, row);
  render();
};

// ---------- 問題 ----------
function chapterStats(ch) {
  const qs = allQuestions().filter(q => q.chapter === ch && (state.ownInStats || !q.own));
  const ids = new Set(qs.map(q => q.id));
  const recent = state.log.filter(e => ids.has(e.id)).slice(-RECENT);
  let tries = recent.length, ok = recent.filter(e => e.ok).length;
  if (!tries) { // 記録を取る前に解いた分は、これまでの合計で出す
    for (const q of qs) { const r = state.quiz[q.id]; if (r) { tries += r.tries; ok += r.correct; } }
  }
  return { n: qs.length, tries, ok, rate: tries ? ok / tries : null };
}
// 出題の設定（設定ボタンから変える。ふだんは保存した設定で出題する）
const QUIZ_DEFAULT = { chapters: null, source: 'all', count: 0, order: 'random', filter: 'under', threshold: 90 };
const quizCfg = () => Object.assign({}, QUIZ_DEFAULT, state.settings || {});
const OPT = {
  source: [['all', 'すべて'], ['official', 'ドリルの問題だけ'], ['own', '✍️自作だけ']],
  count: [[0, 'ぜんぶ'], [5, '5問'], [10, '10問'], [20, '20問']],
  order: [['random', 'ランダム'], ['chapter', '分野の順'], ['weak', '苦手な順（正解率が低い順）'], ['new', 'まだ解いていない問題から']],
  filter: [['all', 'しぼらない'], ['under', '正解率が○%未満の分野だけ'], ['wrong', '前回まちがえた問題だけ']],
  threshold: [[50, '50%'], [70, '70%'], [80, '80%'], [90, '90%']],
};
const optLabel = (key, v) => (OPT[key].find(([x]) => x === v) || [, ''])[1];
function cfgSummary(cfg) {
  const f = cfg.filter === 'under' ? `正解率${cfg.threshold}%未満の分野だけ` : optLabel('filter', cfg.filter);
  return `${optLabel('source', cfg.source)}・${optLabel('count', cfg.count)}・${optLabel('order', cfg.order).replace(/（.*）/, '')}・${f}`;
}

// 選んだ分野と設定から、出題する問題を選ぶ（順番はまだ決めない）
function pickQuestions(picked, c) {
  let qs = allQuestions().filter(q => picked.has(q.chapter));
  if (c.source === 'official') qs = qs.filter(q => !q.own);
  if (c.source === 'own') qs = qs.filter(q => q.own);
  if (c.filter === 'under') qs = qs.filter(q => { const r = chapterStats(q.chapter).rate; return r == null || r < c.threshold / 100; });
  if (c.filter === 'wrong') qs = qs.filter(q => state.quiz[q.id] && state.quiz[q.id].last === false);
  return qs;
}

// 問題を解く：分野を選んでスタートするだけ
function quizMenu() {
  setTitle('問題を解く');
  const open = CHAPTERS.filter(c => allQuestions().some(q => q.chapter === c));
  const locked = Object.keys(data.locked.questions).filter(c => !open.includes(c));
  const cfg = quizCfg();
  const picked = new Set((cfg.chapters || open).filter(c => open.includes(c)));
  if (!picked.size) open.forEach(c => picked.add(c));
  const summaryBox = el('div', { class: 'cfg-box' });
  const renderSummary = () => {
    const c = quizCfg();
    const n = Math.min(pickQuestions(picked, c).length, c.count || Infinity);
    const f = c.filter === 'under' ? `正解率${c.threshold}%未満の分野だけ` : optLabel('filter', c.filter);
    const row = (k, v) => el('div', { class: 'cfg-row' }, el('span', { class: 'cfg-k' }, k), el('span', { class: 'cfg-v' }, v));
    summaryBox.innerHTML = '';
    summaryBox.append(
      el('div', { class: 'cfg-head' },
        el('span', {}, 'この設定で出る問題 ', el('b', { class: 'cfg-n' }, `${n}問`)),
        el('button', { class: 'linkish', onclick: () => go('quiz_settings') }, '⚙️ 設定を変える')),
      row('出題元', optLabel('source', c.source)),
      row('問題数', c.count ? `${c.count}問まで` : 'ぜんぶ'),
      row('順番', optLabel('order', c.order)),
      row('しぼりこみ', f));
  };
  const keep = () => { state.settings = { ...quizCfg(), chapters: [...picked] }; save(); renderSummary(); };

  const chipsBox = el('div', { class: 'chips' },
    open.map(c => {
      const s = chapterStats(c);
      const grad = s.rate != null && s.rate >= GRADUATE;
      const b = el('button', { class: 'chip', 'aria-pressed': String(picked.has(c)) }, `${c}（${s.n}問${s.rate != null ? `・${Math.round(s.rate * 100)}%` : ''}）${grad ? ' 🎓' : ''}`);
      b.addEventListener('click', () => { picked.has(c) ? picked.delete(c) : picked.add(c); b.setAttribute('aria-pressed', picked.has(c)); keep(); });
      return b;
    }),
    locked.map(c => el('button', { class: 'chip', disabled: true }, c, el('span', { class: 'lock' }, '🔒'))));
  const allBtn = el('button', { class: 'chip', onclick: () => {
    const on = picked.size !== open.length;
    open.forEach(c => on ? picked.add(c) : picked.delete(c));
    chipsBox.querySelectorAll('.chip:not([disabled])').forEach(b => b.setAttribute('aria-pressed', String(on)));
    keep();
  } }, '全部えらぶ／はずす');

  view.append(
    el('div', { class: 'quiz-top' },
      el('p', { class: 'muted' }, '分野を選んで、スタート。'),
      el('button', { class: 'btn ghost set-btn', onclick: () => go('quiz_settings') }, '⚙️ 設定')),
    el('div', { class: 'chips' }, allBtn), chipsBox,
    el('button', { class: 'btn wide', onclick: () => {
      const c = quizCfg();
      let qs = pickQuestions(picked, c);
      if (!qs.length) return alertInline('この設定だと、解く問題がありませんぴーぷ。分野を選び直すか、設定の「正解率でしぼる」を変えてくださいぴーぷ');
      const qRate = q => { const r = state.quiz[q.id]; return r ? r.correct / r.tries : -1; };
      if (c.order === 'random') qs = shuffle(qs);
      if (c.order === 'chapter') qs = qs.slice().sort((a, b) => a.chapter.localeCompare(b.chapter) || a.id.localeCompare(b.id));
      if (c.order === 'weak') {
        const cr = {}; for (const ch of new Set(qs.map(q => q.chapter))) cr[ch] = chapterStats(ch).rate ?? -1;
        qs = shuffle(qs).sort((a, b) => cr[a.chapter] - cr[b.chapter] || qRate(a) - qRate(b));
      }
      if (c.order === 'new') qs = shuffle(qs).sort((a, b) => (state.quiz[a.id] ? 1 : 0) - (state.quiz[b.id] ? 1 : 0));
      if (c.count) qs = qs.slice(0, c.count);
      go('quiz_play', qs);
    } }, 'スタート'),
    summaryBox,
    locked.length ? el('p', { class: 'muted' }, '🔒 の分野は、合言葉でひらきます。') : null,
  );
  renderSummary();
}

// 出題の設定（出題元・問題数・順番・正解率でしぼる）
routes.quiz_settings = () => {
  setTitle('出題の設定');
  const cfg = quizCfg();
  const pick = (key) => el('div', { class: 'chips' }, OPT[key].map(([v, label]) => {
    const b = el('button', { class: 'chip', 'aria-pressed': String(cfg[key] === v) }, label);
    b.addEventListener('click', () => {
      cfg[key] = v; state.settings = { ...cfg }; save();
      b.parentElement.querySelectorAll('.chip').forEach(x => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
    });
    return b;
  }));
  const section = (title, ...kids) => el('div', { class: 'card-box setting' }, el('h2', {}, title), ...kids);
  view.append(
    el('p', { class: 'muted' }, '選んだ設定は、次から毎回使われます。'),
    section('出題元', pick('source')),
    section('問題数', pick('count')),
    section('順番', pick('order')),
    section('正解率でしぼる', pick('filter'),
      el('p', { class: 'muted' }, '○%の値（90%＝すーさんの卒業ライン）'), pick('threshold')),
    el('div', { class: 'row' },
      el('button', { class: 'btn ghost', onclick: () => {
        state.settings = { ...QUIZ_DEFAULT, chapters: cfg.chapters }; save(); go('quiz_settings', null, false);
      } }, 'はじめの設定にもどす'),
      el('button', { class: 'btn', onclick: () => backBtn.click() }, '決めてもどる')),
  );
};
routes.quiz_play = qs => {
  setTitle('問題を解く');
  // done[i] = { mine: ['a'], ok: true }：解いた問題は、あとから戻って見直せる
  let i = 0;
  const done = [];
  const keys = 'abcde';
  const render = () => {
    view.innerHTML = '';
    const q = qs[i];
    const answers = q.answer.split(',').map(s => s.trim());
    const multi = answers.length > 1;
    const rec = done[i];
    const chosen = new Set(rec ? rec.mine : []);
    const btns = q.choices.map((t, k) => {
      const b = el('button', { class: 'choice', 'aria-pressed': String(chosen.has(keys[k])) }, el('span', { class: 'key' }, keys[k]), el('span', {}, t));
      b.addEventListener('click', () => {
        if (done[i]) return;
        const key = keys[k];
        if (!multi) { chosen.clear(); btns.forEach(x => x.setAttribute('aria-pressed', 'false')); }
        chosen.has(key) ? chosen.delete(key) : chosen.add(key);
        b.setAttribute('aria-pressed', chosen.has(key));
        submit.disabled = chosen.size === 0;
      });
      return b;
    });
    const after = el('div');
    const showResult = (ok) => {
      btns.forEach((b, k) => {
        if (answers.includes(keys[k])) b.classList.add('correct');
        else if (chosen.has(keys[k])) b.classList.add('wrong');
      });
      const nextLabel = i + 1 < qs.length ? (done[i + 1] ? '次の問題を見る' : '次の問題へ') : '結果を見る';
      after.append(
        el('div', { class: `result ${ok ? 'ok' : 'ng'}` }, ok ? '⭕ 正解' : `❌ 不正解（正解：${answers.join('・')}）`),
        q.explanation ? el('p', { class: 'explain' }, q.explanation) : null,
        q.peep ? peepBox(q.peep) : null,
        q.source ? el('p', { class: 'muted' }, `根拠：${q.source}（${q.checked}確認）`) : null,
        el('div', { class: 'row' },
          i > 0 ? el('button', { class: 'btn ghost', onclick: () => { i--; render(); } }, '‹ 前の問題') : null,
          el('button', { class: 'btn', onclick: () => { i++; i < qs.length ? render() : finish(); } }, nextLabel)));
    };
    const submit = el('button', { class: 'btn wide', disabled: true, onclick: () => {
      if (done[i]) return;
      const ok = chosen.size === answers.length && answers.every(a => chosen.has(a));
      done[i] = { mine: [...chosen], ok };
      recordAnswer(q, ok); save();
      submit.remove();
      showResult(ok);
    } }, 'こたえる');
    view.append(
      el('div', { class: 'progress' }, `${q.own ? '✍️自作　' : ''}${isArticle(q) ? '📝記事　' : ''}${q.chapter}　${i + 1} / ${qs.length}${rec ? '　（見直し中）' : ''}`),
      el('div', { class: 'card-box' },
        el('div', { class: 'q-text' }, q.question), qImg(q),
        multi ? el('p', { class: 'muted' }, `${answers.length}つ選んでください`) : null,
        el('div', { class: 'choices' }, btns),
        rec ? null : submit,
        !rec && i > 0 ? el('button', { class: 'btn ghost wide', style: 'margin-top:8px', onclick: () => { i--; render(); } }, '‹ 前の問題を見直す') : null,
        after));
    if (rec) showResult(rec.ok);
    window.scrollTo(0, 0);
  };
  const finish = () => {
    view.innerHTML = '';
    const score = done.filter(d => d && d.ok).length;
    const r = score / qs.length;
    const line = PEEP_RESULT.find(([th]) => r >= th)[1];
    view.append(
      el('div', { class: 'card-box' },
        el('p', { style: 'text-align:center;margin:0' }, '今回の正解率'),
        el('div', { class: 'big' }, `${Math.round(r * 100)}%`),
        el('p', { style: 'text-align:center' }, `${score} / ${qs.length} 問`),
        peepBox(line)),
      el('div', { class: 'card-box' }, el('h2', {}, '解いた問題を見直す'),
        el('div', { class: 'exam-nav' }, qs.map((q, k) => el('button', {
          class: `exam-num ${done[k] && done[k].ok ? 'done' : 'miss'}`,
          onclick: () => { i = k; render(); },
        }, `${done[k] && done[k].ok ? '⭕' : '❌'}${k + 1}`)))),
      el('button', { class: 'btn wide', onclick: () => go('stats') }, 'マイページで分野ごとの正解率を見る'),
    );
  };
  render();
};

// ---------- 試験モード（本番：100問・170分。最後にまとめて答え合わせ） ----------
const EXAM_Q = 100, EXAM_MIN = 170;
const EXAM_PER_CH = 5; // 20分野から5問ずつ（本番の分野ごとの配分は公表されていないので均等にする）
// 分野ごとに5問ずつランダムに選び、全体の順番もランダムにする（足りない分野は、ある分だけ）
function pickExam(pool) {
  const picked = [];
  for (const c of CHAPTERS) picked.push(...shuffle(pool.filter(q => q.chapter === c)).slice(0, EXAM_PER_CH));
  return shuffle(picked);
}
let examTimer = null;
// 一時停止：止めた時刻を覚え、再開したら止めていた分だけ開始時刻を後ろにずらす
function pauseExam() { const r = state.examRun; if (r && !r.pausedAt) { r.pausedAt = Date.now(); save(); } }
function resumeExam() { const r = state.examRun; if (r && r.pausedAt) { r.start += Date.now() - r.pausedAt; r.pausedAt = null; save(); } }
document.addEventListener('visibilitychange', () => { if (document.hidden && examTimer) pauseExam(); });
const stopExamTimer = () => { if (examTimer) { clearInterval(examTimer); examTimer = null; } };
const fmtTime = sec => { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`; };

routes.exam = () => {
  setTitle('試験モード');
  const pool = allQuestions().filter(q => !q.own);
  const n = CHAPTERS.reduce((a, c) => a + Math.min(EXAM_PER_CH, pool.filter(q => q.chapter === c).length), 0);
  const limitSec = Math.round(EXAM_MIN * 60 * n / EXAM_Q);
  const run = state.examRun;
  view.append(
    el('div', { class: 'card-box exam-intro' },
      el('h2', {}, '本番と同じ形で解く'),
      el('div', { class: 'exam-spec' },
        el('div', {}, el('span', { class: 'muted' }, '問題数'), el('b', {}, `${n}問`)),
        el('div', {}, el('span', { class: 'muted' }, '制限時間'), el('b', {}, `${fmtTime(limitSec)}`))),
      el('p', { class: 'muted' }, n < EXAM_Q
        ? `本番は${EXAM_Q}問・${EXAM_MIN}分（2時間50分）です。今ひらいている問題から、20分野それぞれ最大${EXAM_PER_CH}問を選ぶと${n}問なので、同じ割合（1問あたり1.7分）で出題します。`
        : `本番と同じ${EXAM_Q}問・${EXAM_MIN}分（2時間50分）です。`),
      el('ul', { class: 'exam-rules' },
        el('li', {}, `20分野から${EXAM_PER_CH}問ずつ選び、分野をまぜた順番で出題します。`),
        el('li', {}, '途中で答えは出ません。最後にまとめて答え合わせします。'),
        el('li', {}, '「あとで見直す」の印をつけて、問題一覧から戻れます。'),
        el('li', {}, '時間になると、自動で終了して採点します。'),
        el('li', {}, '「⏸ 一時停止」で時間を止められます。試験の画面を離れたり、ほかのアプリに切りかえたりしても、自動で止まります。'),
        el('li', {}, '自作の問題は入りません。')),
      el('button', { class: 'btn wide', disabled: n === 0, onclick: () => {
        const qs = pickExam(pool).map(q => q.id);
        state.examRun = { ids: qs, answers: {}, flags: {}, start: Date.now(), limit: limitSec, cur: 0 }; save();
        go('exam_play');
      } }, '試験をはじめる'),
      run ? el('button', { class: 'btn ghost wide', style: 'margin-top:10px', onclick: () => go('exam_play') }, `途中の試験を続ける（${Object.keys(run.answers).length}/${run.ids.length}問 解答済み${run.pausedAt ? '・一時停止中' : ''}）`) : null),
    examHistory(),
  );
};

function examHistory() {
  const hist = state.exams || [];
  if (!hist.length) return null;
  return el('div', { class: 'card-box' }, el('h2', {}, 'これまでの試験'),
    hist.slice(-10).reverse().map(h => {
      const lv = rateLevel(h.ok / h.n);
      const idx = hist.indexOf(h);
      return el('button', { class: `stat hist-row ${lv.cls}`, onclick: () => go('exam_result', idx) },
        el('span', {}, new Date(h.at).toLocaleDateString('ja-JP'), el('span', { class: 'muted' }, `　${h.n}問・${fmtTime(h.used)}`)),
        el('span', { class: 'exam-score' }, `${Math.round(h.ok / h.n * 100)}%（${h.ok}/${h.n}）›`));
    }), el('p', { class: 'muted' }, 'タップすると、その回の答え合わせを見直せます。'));
}

routes.exam_play = () => {
  setTitle('試験モード');
  const run = state.examRun;
  if (!run) return go('exam', null, false);
  const qs = run.ids.map(id => allQuestions().find(q => q.id === id)).filter(Boolean);
  if (!qs.length) {
    state.examRun = null; save();
    go('exam', null, false);
    return alertInline('途中の試験の問題が見つからなかったので、この試験は取り消しましたぴーぷ');
  }
  run.cur = Math.min(Math.max(0, run.cur || 0), qs.length - 1);
  let finished = false;
  const keys = 'abcde';
  const timeLeft = () => run.limit - ((run.pausedAt || Date.now()) - run.start) / 1000;
  const bar = el('div', { class: 'exam-bar' });
  const body = el('div');
  let armedFinish = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    stopExamTimer();
    resumeExam();
    const used = Math.min(run.limit, (Date.now() - run.start) / 1000);
    const result = qs.map(q => {
      const ans = q.answer.split(',').map(s => s.trim()).sort().join(',');
      const mine = (run.answers[q.id] || []).slice().sort().join(',');
      const ok = mine === ans;
      recordAnswer(q, ok);
      return { id: q.id, mine, ok };
    });
    const ok = result.filter(r => r.ok).length;
    state.exams = (state.exams || []).concat({ at: Date.now(), n: qs.length, ok, used, result });
    state.examRun = null; save();
    go('exam_result', state.exams.length - 1, false);
  };

  const renderBar = () => {
    const answered = qs.filter(q => (run.answers[q.id] || []).length).length;
    const left = timeLeft();
    bar.innerHTML = '';
    bar.append(
      el('span', { class: `exam-time${left < 300 ? ' low' : ''}` }, `残り ${fmtTime(left)}`),
      el('span', { class: 'muted' }, `解答 ${answered}/${qs.length}`),
      el('button', { class: 'btn ghost pause-btn', onclick: () => { pauseExam(); showPaused(); } }, '⏸ 一時停止'));
    if (run.pausedAt && !body.querySelector('.paused')) showPaused();
    if (left <= 0 && !run.pausedAt) finish();
  };

  const render = () => {
    body.innerHTML = '';
    const q = qs[run.cur];
    const answers = q.answer.split(',');
    const multi = answers.length > 1;
    const mine = new Set(run.answers[q.id] || []);
    const btns = q.choices.map((t, k) => {
      const b = el('button', { class: 'choice', 'aria-pressed': String(mine.has(keys[k])) }, el('span', { class: 'key' }, keys[k]), el('span', {}, t));
      b.addEventListener('click', () => {
        const key = keys[k];
        if (!multi) { mine.clear(); btns.forEach(x => x.setAttribute('aria-pressed', 'false')); }
        mine.has(key) ? mine.delete(key) : mine.add(key);
        b.setAttribute('aria-pressed', mine.has(key));
        run.answers[q.id] = [...mine]; save(); renderBar(); renderNav();
      });
      return b;
    });
    const flag = el('button', { class: 'chip', 'aria-pressed': String(!!run.flags[q.id]) }, '🚩 あとで見直す');
    flag.addEventListener('click', () => { run.flags[q.id] = !run.flags[q.id]; flag.setAttribute('aria-pressed', !!run.flags[q.id]); save(); renderNav(); });
    body.append(
      el('div', { class: 'progress' }, `問${run.cur + 1} / ${qs.length}　${q.chapter}`),
      el('div', { class: 'card-box' },
        el('div', { class: 'q-text' }, q.question), qImg(q),
        multi ? el('p', { class: 'muted' }, `${answers.length}つ選んでください`) : null,
        el('div', { class: 'choices' }, btns),
        el('div', { class: 'chips' }, flag)),
      el('div', { class: 'row' },
        el('button', { class: 'btn ghost', disabled: run.cur === 0, onclick: () => { run.cur--; save(); render(); } }, '‹ 前へ'),
        el('button', { class: 'btn ghost', disabled: run.cur === qs.length - 1, onclick: () => { run.cur++; save(); render(); } }, '次へ ›')),
      nav);
    renderNav();
    window.scrollTo(0, 0);
  };

  const nav = el('div', { class: 'card-box' });
  const renderNav = () => {
    nav.innerHTML = '';
    armedFinish = false;
    const unanswered = qs.filter(q => !(run.answers[q.id] || []).length).length;
    const endBtn = el('button', { class: 'btn wide', onclick: () => {
      if (!armedFinish) { armedFinish = true; endBtn.textContent = unanswered ? `未解答が${unanswered}問あります。もう一度押すと終了して採点` : 'もう一度押すと終了して採点'; return; }
      finish();
    } }, '解答を終了して答え合わせ');
    nav.append(
      el('h2', {}, '問題一覧'),
      el('p', { class: 'muted' }, '番号をタップでその問題へ。緑＝解答済み、🚩＝見直し'),
      el('div', { class: 'exam-nav' }, qs.map((q, i) => el('button', {
        class: `exam-num${(run.answers[q.id] || []).length ? ' done' : ''}${run.flags[q.id] ? ' flag' : ''}${i === run.cur ? ' cur' : ''}`,
        onclick: () => { run.cur = i; save(); render(); },
      }, String(i + 1)))),
      endBtn);
  };

  const showPaused = () => {
    body.innerHTML = '';
    body.append(el('div', { class: 'card-box paused' },
      el('div', { class: 'big' }, '⏸'),
      el('p', { style: 'text-align:center' }, `一時停止中です。時間は止まっています（残り ${fmtTime(timeLeft())}）。`),
      peepBox('休憩も大事ですぴーぷ。でも、戻ってこないのはナシですぴーぷ'),
      el('button', { class: 'btn wide', onclick: () => { resumeExam(); render(); renderBar(); } }, '▶ 再開する')));
  };

  view.append(bar, body);
  stopExamTimer();
  examTimer = setInterval(renderBar, 1000);
  if (run.pausedAt) { renderBar(); showPaused(); } else { render(); renderBar(); }
};

routes.exam_result = idx => {
  setTitle('試験の結果');
  const h = (state.exams || [])[idx];
  if (!h || !h.n) return go('exam', null, false);
  const rate = h.ok / h.n;
  const lv = rateLevel(rate);
  const byCh = {};
  for (const r of h.result) {
    const q = allQuestions().find(x => x.id === r.id); if (!q) continue;
    const b = byCh[q.chapter] = byCh[q.chapter] || { n: 0, ok: 0 };
    b.n++; if (r.ok) b.ok++;
  }
  const line = PEEP_RESULT.find(([th]) => rate >= th)[1];
  const list = el('div', { class: 'card-box' }, el('h2', {}, '答え合わせ'), el('p', { class: 'muted' }, 'タップで解説がひらきます。'));
  h.result.forEach((r, i) => {
    const q = allQuestions().find(x => x.id === r.id); if (!q) return;
    const d = el('details', { class: `ans ${r.ok ? 'ok' : 'ng'}` },
      el('summary', {}, `${r.ok ? '⭕' : '❌'} 問${i + 1}　`, el('span', { class: 'muted' }, q.chapter)),
      el('p', { class: 'q-text' }, q.question), qImg(q),
      el('ol', { class: 'ans-choices', type: 'a' }, q.choices.map((t, k) => {
        const key = 'abcde'[k];
        const cls = q.answer.split(',').includes(key) ? 'right' : r.mine.split(',').includes(key) ? 'wrong' : '';
        return el('li', { class: cls }, t);
      })),
      el('p', {}, `正解：${q.answer.split(',').join('・')}　あなた：${r.mine ? r.mine.split(',').join('・') : '未解答'}`),
      q.explanation ? el('p', { class: 'explain' }, q.explanation) : null,
      q.peep ? peepBox(q.peep) : null);
    list.append(d);
  });
  view.append(
    el('div', { class: 'card-box' },
      el('p', { style: 'text-align:center;margin:0' }, '試験の正解率'),
      el('div', { class: `big exam-big ${lv.cls}` }, `${Math.round(rate * 100)}%`),
      el('p', { style: 'text-align:center' }, `${h.ok} / ${h.n} 問　・　かかった時間 ${fmtTime(h.used)}`),
      peepBox(line)),
    el('div', { class: 'card-box' }, el('h2', {}, '分野ごと'),
      CHAPTERS.filter(c => byCh[c]).map(c => {
        const b = byCh[c], p = Math.round(b.ok / b.n * 100), l = rateLevel(b.ok / b.n);
        return el('div', { class: `stat ${l.cls}` }, el('span', {}, c), el('span', {}, `${p}%（${b.ok}/${b.n}）`),
          el('div', { class: 'meter' }, el('i', { class: 'lvbar', style: `width:${p}%` })));
      })),
    list,
    el('button', { class: 'btn wide', onclick: () => go('home') }, 'ホームにもどる'),
  );
};

// ---------- マイページ ----------
function stats() {
  setTitle('マイページ');
  confirmInline.armed = false;
  const { tries, ok } = overallRate();
  const rows = CHAPTERS.map(c => ({ c, ...chapterStats(c) }));
  const grads = rows.filter(r => r.rate != null && r.rate >= GRADUATE).length;
  const summary = el('div', { class: 'tiles' },
    tile('全体の正解率', tries ? `${Math.round(ok / tries * 100)}%` : '—', tries ? `${ok}/${tries}` : 'まだ解いていない'),
    tile('卒業した分野', `${grads}`, '/ 20分野'),
    tile('自作', `${state.own.questions.length + state.own.cards.length}`, `問題${state.own.questions.length}・カード${state.own.cards.length}`));

  const ownToggle = el('button', { class: 'chip', 'aria-pressed': String(state.ownInStats) }, '✍️ 自作の問題も正解率に入れる');
  ownToggle.addEventListener('click', () => { state.ownInStats = !state.ownInStats; save(); go('stats', null, false); });
  const box = el('div', { class: 'card-box' },
    el('h2', {}, '分野ごとの正解率'),
    el('p', { class: 'muted' }, `正解率は、分野ごとに直近${RECENT}回の解答で出しています。`),
    el('div', { class: 'chips' }, ownToggle),
    el('p', { class: 'muted' }, '番号をタップすると分野名が出ます。緑の点線が卒業ライン（90%）。うすい番号は、未回答か準備中の分野です。'),
    radar(rows));
  const list = el('div', { class: 'card-box' }, el('h2', {}, '分野ごとの一覧'));
  for (const r of rows.filter(r => r.n > 0)) {
    const pct = r.rate == null ? null : Math.round(r.rate * 100);
    const grad = r.rate != null && r.rate >= GRADUATE;
    list.append(el('div', { class: 'stat' },
      el('span', {}, r.c),
      el('span', {}, pct == null ? el('span', { class: 'muted' }, `未回答（${r.n}問）`) : `${pct}%（${r.ok}/${r.tries}）`, grad ? el('span', { class: 'badge' }, ' 🎓卒業') : null),
      el('div', { class: 'meter' }, el('i', { class: grad ? 'grad' : '', style: `width:${pct || 0}%` }))));
  }
  const prep = rows.filter(r => r.n === 0);
  if (prep.length) list.append(el('p', { class: 'muted prep' }, `準備中の分野（問題を順番に追加していきます）：${prep.map(r => r.c.slice(0, 2)).join('・')}`));
  const cbox = el('div', { class: 'card-box' }, el('h2', {}, '暗記カード（覚えた割合）'));
  for (const c of cardCats().open) {
    const cs = allCards().filter(x => cardKey(x) === c);
    const k = cs.filter(x => state.cards[x.id] === 'known').length;
    const pct = Math.round(k / cs.length * 100);
    cbox.append(el('div', { class: 'stat' }, el('span', {}, c), el('span', {}, `${k}/${cs.length}`),
      el('div', { class: 'meter' }, el('i', { class: pct >= 90 ? 'grad' : '', style: `width:${pct}%` }))));
  }
  view.append(
    summary,
    peepBox(grads ? `${grads}分野、卒業ですぴーぷ。卒業した分野は、繰り返しから外していいですぴーぷ` : '正解率90%以上の分野は、繰り返しから外していいですぴーぷ。すーさんもそうしてましたぴーぷ'),
    box, list, cbox,
    backupBox(),
    el('button', { class: 'btn ghost wide', style: 'margin-top:18px', onclick: () => {
      if (!confirmInline.armed) { confirmInline.armed = true; alertInline('もう一度押すと、正解率と覚えた記録を消しますぴーぷ（自作の問題・カードは残ります）。'); return; }
      state.cards = {}; state.quiz = {}; state.log = []; save(); confirmInline.armed = false; go('stats', null, false);
    } }, '正解率の記録をリセット'),
  );
}
function tile(label, value, sub) {
  return el('div', { class: 'tile' }, el('div', { class: 'muted' }, label), el('div', { class: 'tile-v' }, value), el('div', { class: 'muted' }, sub));
}

// レーダーチャート（1系列・20分野。まだ解いていない分野は中心に白抜きの点）
function radar(rows) {
  const NS = 'http://www.w3.org/2000/svg';
  const S = 360, C = S / 2, R = 132, n = rows.length;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${S} ${S}`);
  svg.setAttribute('class', 'radar');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '分野ごとの正解率のレーダーチャート。数字は下の一覧と同じです。');
  const mk = (tag, a) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const pt = (i, v) => { const t = -Math.PI / 2 + i * 2 * Math.PI / n; return [C + Math.cos(t) * R * v, C + Math.sin(t) * R * v]; };
  const ring = v => rows.map((_, i) => pt(i, v).join(',')).join(' ');
  for (const v of [0.25, 0.5, 0.75, 1]) svg.append(mk('polygon', { points: ring(v), class: 'r-grid' }));
  svg.append(mk('polygon', { points: ring(GRADUATE), class: 'r-grad' }));
  rows.forEach((_, i) => { const [x, y] = pt(i, 1); svg.append(mk('line', { x1: C, y1: C, x2: x, y2: y, class: 'r-axis' })); });
  for (const v of [0.5, 1]) { const t = mk('text', { x: C + 3, y: C - R * v - 3, class: 'r-tick' }); t.textContent = `${v * 100}%`; svg.append(t); }
  svg.append(mk('polygon', { points: rows.map((r, i) => pt(i, r.rate || 0).join(',')).join(' '), class: 'r-area' }));
  const tip = el('div', { class: 'r-tip' }, 'タップで分野名');
  rows.forEach((r, i) => {
    const [lx, ly] = pt(i, 1.13);
    const lab = mk('text', { x: lx, y: ly, class: r.rate == null ? 'r-label dim' : 'r-label', 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
    lab.textContent = r.c.slice(0, 2);
    svg.append(lab);
    const [x, y] = pt(i, r.rate || 0);
    const dot = mk('circle', { cx: x, cy: y, r: 4.5, class: 'r-dot' });
    if (r.rate != null) svg.append(dot);
    const show = () => {
      tip.textContent = `${r.c}：${r.n === 0 ? '準備中' : r.rate == null ? '未回答' : `${Math.round(r.rate * 100)}%（${r.ok}/${r.tries}）`}`;
      svg.querySelectorAll('.r-dot').forEach(d => d.classList.remove('on'));
      dot.classList.add('on');
    };
    // 当たり判定は点より大きく、ラベルでも反応する
    for (const target of [mk('circle', { cx: x, cy: y, r: 14, class: 'r-hit' }), mk('circle', { cx: lx, cy: ly, r: 13, class: 'r-hit' })]) {
      target.addEventListener('click', show);
      target.addEventListener('mouseenter', show);
      svg.append(target);
    }
  });
  return el('div', { class: 'radar-wrap' }, svg, tip);
}

// 記録は端末の中だけなので、書き出し・読み込みでバックアップできるようにする
function backupBox() {
  let pending = null;
  const note = el('p', { class: 'muted' });
  const file = el('input', { type: 'file', accept: 'application/json', hidden: true });
  file.addEventListener('change', async () => {
    try {
      const d = JSON.parse(await file.files[0].text());
      if (!d || typeof d !== 'object' || !('quiz' in d) || !('cards' in d)) throw new Error('shape');
      pending = normalizeState(d);
      note.textContent = `読み込むと、今の記録と自作の問題・カードが、このファイルの内容に置きかわります（問題${pending.own.questions.length}・カード${pending.own.cards.length}）。よければ「読み込む」をもう一度押してください。`;
    } catch { pending = null; alertInline('このアプリのバックアップではないファイルでしたぴーぷ'); }
    file.value = '';
  });
  return el('div', { class: 'card-box' },
    el('h2', {}, '記録のバックアップ'),
    el('p', { class: 'muted' }, '正解率と自作の問題・カードは、このスマホの中だけに保存されています。機種変更の前に書き出しておくと安心です。'),
    el('div', { class: 'row' },
      el('button', { class: 'btn ghost', onclick: () => {
        const blob = new Blob([JSON.stringify(state)], { type: 'application/json' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `peep-drill-backup-${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(a); a.click(); a.remove();
      } }, '書き出す'),
      el('button', { class: 'btn ghost', onclick: () => {
        if (pending) { state = pending; pending = null; save(); go('stats', null, false); return; }
        file.click();
      } }, '読み込む')),
    note, file);
}

// ---------- 自作の問題・カード ----------
const canAddOwnQuestion = () => unlocked || state.own.questions.length < FREE_OWN_QUESTIONS;
const canAddOwnCard = () => unlocked || state.own.cards.length < FREE_OWN_CARDS;
function ownList() {
  setTitle('自作の問題・カード');
  const qs = state.own.questions, cs = state.own.cards;
  const addQ = el('button', { class: 'btn', onclick: () => {
    if (!canAddOwnQuestion()) return alertInline(`アプリの合言葉なしで作れる問題は${FREE_OWN_QUESTIONS}問までですぴーぷ。アプリの合言葉を入れると、いくつでも作れますぴーぷ`);
    go('own_q');
  } }, '＋ 5択の問題');
  view.append(
    peepBox('間違えたところは、自分で問題にすると忘れませんぴーぷ。わかったふりの予防ですぴーぷ'),
    el('div', { class: 'row' }, addQ, el('button', { class: 'btn', onclick: () => {
      if (!canAddOwnCard()) return alertInline(`アプリの合言葉なしで作れるカードは${FREE_OWN_CARDS}枚までですぴーぷ。アプリの合言葉を入れると、いくつでも作れますぴーぷ`);
      go('own_c');
    } }, '＋ 暗記カード')),
    unlocked ? null : el('p', { class: 'muted' }, `アプリの合言葉なしで作れるのは、問題あと${Math.max(0, FREE_OWN_QUESTIONS - qs.length)}問（全${FREE_OWN_QUESTIONS}問）・カードあと${Math.max(0, FREE_OWN_CARDS - cs.length)}枚（全${FREE_OWN_CARDS}枚）`),
    el('div', { class: 'card-box' }, el('h2', {}, `自作の問題（${qs.length}）`),
      qs.length ? qs.map(q => ownRow(q.chapter, q.question, () => go('own_q', q.id), () => { state.own.questions = qs.filter(x => x !== q); delete state.quiz[q.id]; save(); go('own', null, false); }))
        : el('p', { class: 'muted' }, 'まだありません。作った問題は「問題を解く」で、その分野に混ざって出ます。')),
    el('div', { class: 'card-box' }, el('h2', {}, `自作の暗記カード（${cs.length}）`),
      cs.length ? cs.map(c => ownRow(c.chapter || c.category, c.front, () => go('own_c', c.id), () => { state.own.cards = cs.filter(x => x !== c); delete state.cards[c.id]; save(); go('own', null, false); }))
        : el('p', { class: 'muted' }, 'まだありません。作ったカードは「暗記カード」で出ます。')),
  );
}
function ownRow(tag, text, onEdit, onDel) {
  let armed = false;
  const del = el('button', { class: 'chip', onclick: () => { if (!armed) { armed = true; del.textContent = 'もう一度で削除'; return; } onDel(); } }, '削除');
  return el('div', { class: 'stat' },
    el('span', {}, el('span', { class: 'muted' }, tag), el('br'), text.length > 40 ? text.slice(0, 40) + '…' : text),
    el('span', { class: 'row', style: 'margin:0' }, el('button', { class: 'chip', onclick: onEdit }, '直す'), del));
}
const newId = p => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const field = (label, input) => el('label', { class: 'field' }, el('span', {}, label), input);

routes.own_q = id => {
  const cur = state.own.questions.find(q => q.id === id);
  setTitle(cur ? '自作の問題を直す' : '5択の問題をつくる');
  const ch = el('select', {}, CHAPTERS.map(c => el('option', { value: c, selected: cur?.chapter === c }, c)));
  const qt = el('textarea', { rows: 3, placeholder: '例：PaO₂ 60mmHg、FiO₂ 0.4 のときのP/F比はどれか。' }); qt.value = cur?.question || '';
  const keys = 'abcde';
  const ans = new Set((cur?.answer || '').split(',').filter(Boolean));
  const chs = keys.split('').map((k, i) => {
    const t = el('input', { type: 'text', placeholder: `${k} の選択肢` }); t.value = cur?.choices[i] || '';
    const cb = el('input', { type: 'checkbox', checked: ans.has(k) });
    return { k, t, cb, row: el('div', { class: 'opt' }, el('label', { class: 'ok-mark' }, cb, '正解'), el('b', {}, k), t) };
  });
  const ex = el('textarea', { rows: 3, placeholder: 'なぜその答えになるか（なくてもOK）' }); ex.value = cur?.explanation || '';
  view.append(el('form', { class: 'card-box form', onsubmit: e => {
    e.preventDefault();
    const choices = chs.map(c => c.t.value.trim());
    const answer = chs.filter(c => c.cb.checked).map(c => c.k).join(',');
    if (!qt.value.trim() || choices.some(c => !c) || !answer) return alertInline('問題文と5つの選択肢、正解（1つ以上）を入れてくださいぴーぷ');
    if (!cur && !canAddOwnQuestion()) return alertInline(`アプリの合言葉なしで作れる問題は${FREE_OWN_QUESTIONS}問までですぴーぷ`);
    const q = { id: cur?.id || newId('own-q'), chapter: ch.value, question: qt.value.trim(), choices, answer, explanation: ex.value.trim(), peep: '', source: '', checked: '', free: true, own: true };
    if (cur) state.own.questions[state.own.questions.indexOf(cur)] = q; else state.own.questions.push(q);
    save(); backBtn.click();
  } },
    field('分野', ch), field('問題文', qt),
    el('div', { class: 'field' }, el('span', {}, '選択肢（正解にチェック。2つ以上でもOK）'), chs.map(c => c.row)),
    field('解説', ex),
    el('button', { class: 'btn wide', type: 'submit' }, cur ? '保存する' : 'つくる')));
};
routes.own_c = id => {
  const cur = state.own.cards.find(c => c.id === id);
  setTitle(cur ? '自作のカードを直す' : '暗記カードをつくる');
  // 分野は20章から選ぶ（入力候補リストはスマホで閉じなくなることがあるので使わない）
  const NONE = '';
  const ch = el('select', {}, el('option', { value: NONE }, '分野なし（自作）'),
    CHAPTERS.map(c => el('option', { value: c, selected: cur?.chapter === c }, c)));
  const fr = el('textarea', { rows: 2, placeholder: '問い（例：β2刺激薬の代表的な副作用は？）' }); fr.value = cur?.front || '';
  const bk = el('textarea', { rows: 2, placeholder: '答え' }); bk.value = cur?.back || '';
  const nt = el('textarea', { rows: 2, placeholder: '補足（なくてもOK）' }); nt.value = cur?.note || '';
  view.append(el('form', { class: 'card-box form', onsubmit: e => {
    e.preventDefault();
    if (!fr.value.trim() || !bk.value.trim()) return alertInline('問いと答えを入れてくださいぴーぷ');
    if (!cur && !canAddOwnCard()) return alertInline(`アプリの合言葉なしで作れるカードは${FREE_OWN_CARDS}枚までですぴーぷ`);
    const c = { id: cur?.id || newId('own-c'), category: '自作', chapter: ch.value || undefined, front: fr.value.trim(), back: bk.value.trim(), note: nt.value.trim(), source: '', checked: '', free: true, own: true };
    if (cur) state.own.cards[state.own.cards.indexOf(cur)] = c; else state.own.cards.push(c);
    save(); backBtn.click();
  } },
    field('分野', ch),
    field('問い', fr), field('答え', bk), field('補足', nt),
    el('button', { class: 'btn wide', type: 'submit' }, cur ? '保存する' : 'つくる')));
};

const confirmInline = { armed: false };

// ---------- 利用規約 ----------
// 章ごとに、アプリと記事で何問・何枚あるか（購入前に確かめられるように）
routes.contents = () => {
  setTitle('中身の一覧');
  const n = (c, k) => data.contents[c]?.[k] ?? 0;
  const sum = k => CHAPTERS.reduce((a, c) => a + n(c, k), 0);
  const row = (cells, head) => el('tr', {}, cells.map((t, i) => el(head ? 'th' : 'td', { class: i ? 'num' : '' }, String(t))));
  view.append(
    el('p', { class: 'muted' }, '暗記カードは、覚えることが多い章ほど枚数を多くしています。記事の問題とカードは、その章の有料記事（またはマガジン）の合言葉で足されます。'),
    el('div', { class: 'card-box table-wrap' }, el('table', { class: 'contents' },
      el('thead', {}, row(['章', 'アプリ 問題', 'アプリ カード', '記事 問題', '記事 カード'], true)),
      el('tbody', {}, CHAPTERS.map(c => row([c, n(c, 'app_q'), n(c, 'app_c'), n(c, 'art_q'), n(c, 'art_c')]))),
      el('tfoot', {}, row(['合計', sum('app_q'), sum('app_c'), sum('art_q'), sum('art_c')], true)))),
    el('p', { class: 'muted' }, 'アプリのカードの数には、無料のお試し分も含みます。問題の数には、お試しの5問は入っていません（別にあります）。'),
  );
};

routes.terms = () => {
  setTitle('利用規約');
  const sec = (h, ...ps) => el('div', { class: 'card-box terms' }, el('h2', {}, h), ...ps.map(t => el('p', {}, t)));
  view.append(
    sec('このアプリについて',
      '「ぴーぷくんの呼吸ドリル」は、三学会合同呼吸療法認定士の試験勉強のための、個人（ひといきPT・すーさん）が作った学習アプリです。試験や講習会を運営する団体とは関係ありません。',
      '問題と解説はオリジナルです。講習会テキストや過去問を写したものではありません。'),
    sec('医療の判断には使わないでください',
      '内容は公開されている資料で確認していますが、まちがいや、資料の改訂で古くなっていることがあります。患者さんや利用者さんへの対応は、必ず最新のガイドラインと、施設の決まり、医師の指示に従ってください。',
      'このアプリを使ったことで生じた損害について、作者は責任を負いません。'),
    sec('合言葉について',
      'アプリの合言葉は、noteで「ぴーぷくんの呼吸ドリル（問題集）」を購入した人だけが使えます。記事の合言葉は、その章の有料記事（またはマガジン）を購入した人だけが使えます。人に教えたり、SNSやネットに載せたりしないでください。',
      '合言葉は、試験の年度ごとに変わります。新しい合言葉は、購入した記事の中でお知らせします。'),
    sec('記録と自作の問題について',
      '正解率の記録や、自作の問題・カードは、お使いのスマホやパソコンの中だけに保存されます。作者のところには送られません。',
      'ブラウザのデータを消したり、機種を変えたりすると消えます。マイページの「書き出す」で、ときどきバックアップしてください。'),
    sec('お問い合わせ',
      'まちがいを見つけたときや、ご質問は、noteの「ひといきPT」（note.com/hitoiki_pt）へ、メッセージかコメントでお知らせください。'),
    el('p', { class: 'muted' }, '2026年9月 作成'),
  );
};

// 図を見て答える問題の図（q.image は app/ からの相対パス。タップで大きく見られる）
function qImg(q) {
  if (!q.image) return null;
  return el('a', { href: q.image, target: '_blank', rel: 'noopener', class: 'q-img-link' },
    el('img', { src: q.image, alt: q.imageAlt || '問題の図', class: 'q-img', loading: 'lazy' }));
}
function peepBox(text) {
  return el('div', { class: 'peep' },
    el('img', { src: 'icon-192.png', alt: '', class: 'peep-ic' }),
    el('div', {}, el('b', {}, 'ぴーぷくん'), el('div', {}, `「${text}」`)));
}
function alertInline(text) {
  let n = view.querySelector('.inline-alert');
  if (!n) { n = el('div', { class: 'inline-alert' }); view.append(n); }
  n.innerHTML = '';
  n.append(peepBox(text));
}

// ---------- 起動 ----------
(async () => {
  try { await loadFree(); }
  catch { view.append(el('p', {}, 'データを読み込めませんでした。通信を確認してください。')); return; }
  const saved = savedPasses();
  const keep = [];
  for (const p of saved) {
    try { await unlock(p); keep.push(p); }
    catch (err) {
      if (err && err.name === 'OperationError') passChanged = true; // 年度がかわって使えなくなった合言葉
      else keep.push(p); // 通信できないだけなら、合言葉は消さない
    }
  }
  if (saved.length) savePasses(keep); // 前の版の保存の形も、ここで配列にそろえる
  go('home');
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
