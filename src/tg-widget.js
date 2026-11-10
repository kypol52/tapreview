// Недельный отчёт владельцу виджетом прямо в сообщении Telegram (Bot API 10.4, sendWidget).
// Виджет — один HTML-файл (не больше 4 КБ после сжатия), цифры приходят в chat_data (JSON до 1024 байт).
// Telegram показывает виджеты только в личном чате с ботом; в группах и при любой ошибке
// telegram.js шлёт обычный текстовый отчёт. Старые приложения показывают вместо виджета подпись (caption).

import { PLATFORMS } from "./report.js";

const MAX_DATA = 1024; // байт, лимит Telegram на chat_data

// Данные для виджета из отчёта (report.js), графика по дням и оценок гостей
//   rating — { avg, count, low, reason } или null; link — ссылка на страницу статистики или null
export function widgetData({ name, range, cur, prev, cards, billing }, daily, rating, link, rangeText) {
  const data = {
    n: String(name).slice(0, 40),
    r: rangeText,
    f: new Date(range.from + 3 * 3600 * 1000).getUTCDay(), // день недели первого дня (МСК)
    v: [cur.views, prev.views],
    c: [cur.clicks, prev.clicks],
    s: [cur.nfc, cur.qr, cur.direct],
    p: PLATFORMS.map((pl) => cur[pl.key]),
    d: daily.map((x) => [x.views, x.clicks]),
    k: cards.slice(0, 3).map((c) => [String(c.name).slice(0, 18), c.views, c.clicks])
  };
  if (rating && rating.count) data.a = [Math.round(rating.avg * 10) / 10, rating.count, rating.low, rating.reason || ""];
  if (billing.state === "ending" || billing.state === "grace") data.b = billing.state === "ending" ? "Подписка скоро закончится — продлите заранее" : "Подписка закончилась, скоро статистика встанет на паузу";
  if (link) data.u = link;

  // Не влезли в лимит — убираем карты, потом причину
  let json = JSON.stringify(data);
  while (bytes(json) > MAX_DATA && data.k.length) { data.k.pop(); json = JSON.stringify(data); }
  if (bytes(json) > MAX_DATA && data.a) { data.a[3] = ""; json = JSON.stringify(data); }
  return json;
}

// Подпись: видна в списке чатов, в уведомлении и в приложениях без поддержки виджетов
export function widgetCaption({ name, cur }, rangeText) {
  return `📊 ${name} · ${rangeText}\nОткрыли страницу: ${cur.views} · перешли к отзыву: ${cur.clicks}`;
}

function bytes(s) {
  return new TextEncoder().encode(s).length;
}

// Сам виджет. Только системные шрифты, без сети; цвета — из темы Telegram + фирменное золото.
export const WEEKLY_WIDGET_HTML = `<style>
body{margin:0;padding:12px 14px max(14px,var(--tg-content-safe-area-inset-bottom,0px));font:15px/1.35 system-ui,sans-serif;color:var(--tg-theme-text-color);background:var(--tg-theme-bg-color)}
.h{font-weight:700;font-size:17px}.m{color:var(--tg-theme-hint-color);font-size:13px}
.k{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}
.t{background:var(--tg-theme-secondary-bg-color);border-radius:12px;padding:9px 10px;border:2px solid transparent}
.t.on{border-color:#e5aa0c}.t b{display:block;font-size:24px}.t b span{font-size:14px;font-weight:600}
.up{color:#2e9e5b}.dn{color:#d9534f}
.ch{display:flex;align-items:flex-end;gap:5px;height:84px;margin-top:4px}
.ch i{flex:1;border-radius:4px 4px 0 0;background:var(--tg-theme-link-color);min-height:2px}
.ch i.g{background:#e5aa0c}
.dl{display:flex;gap:5px}.dl span{flex:1;text-align:center;font-size:11px;color:var(--tg-theme-hint-color)}
.row{display:flex;justify-content:space-between;margin-top:8px;font-size:14px}
.bar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin:6px 0 2px;background:var(--tg-theme-secondary-bg-color)}
.w{margin-top:10px;font-size:13px;color:#d9534f}
button{width:100%;margin-top:12px;padding:10px;border:0;border-radius:10px;font:600 15px system-ui,sans-serif;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}
</style>
<div id="a"></div>
<script>
const W=window.TelegramWidget,DN=['вс','пн','вт','ср','чт','пт','сб'],PL=['Яндекс','Google','2ГИС'],PC=['#fc3f1d','#4285f4','#2fad4d'],A=document.getElementById('a');
let mode=0;
function el(t,c,...k){const n=document.createElement(t);if(c)n.className=c;for(const x of k)if(x!=null&&x!=='')n.appendChild(typeof x=='object'?x:document.createTextNode(String(x)));return n}
function dl(a,b){if(!a&&!b)return'';const d=a-b;return d>0?el('span','up',' ▲'+d):d<0?el('span','dn',' ▼'+(-d)):el('span','m',' =')}
function row(a,b){return el('div','row',el('span','m',a),b)}
function tile(i,t,n,p,x){const d=el('div','t'+(mode==i?' on':''),el('span','m',t),el('b','',n,dl(n,p)),x);d.dataset.m=i;return d}
function draw(){
let D={};try{D=JSON.parse(W&&W.chatData||'{}')}catch(x){}
while(A.firstChild)A.removeChild(A.firstChild);
if(!D.n){A.appendChild(el('div','m','Нет данных'));return}
const v=D.v,c=D.c,d=D.d||[],mx=Math.max(1,...d.map(x=>x[mode])),add=n=>A.appendChild(n);
add(el('div','h',D.n));add(el('div','m','Неделя · '+D.r));
add(el('div','k',tile(0,'Открыли страницу',v[0],v[1]),tile(1,'Перешли к отзыву',c[0],c[1],v[0]&&c[0]?el('span','m',Math.round(c[0]/v[0]*100)+'% от открытий'):'')));
const ch=el('div','ch'),dd=el('div','dl');
d.forEach((x,i)=>{const b=el('i',mode?'g':'');b.style.height=Math.round(x[mode]/mx*100)+'%';ch.appendChild(b);dd.appendChild(el('span','',DN[(D.f+i)%7]))});
add(ch);add(dd);
const p=D.p||[];
if(p.some(n=>n)){const bar=el('div','bar');p.forEach((n,i)=>{if(!n)return;const s=el('i');s.style.flex=n;s.style.background=PC[i];bar.appendChild(s)});add(bar);add(el('div','m',p.map((n,i)=>PL[i]+' '+n).join(' · ')))}
const s=D.s||[0,0,0];if(v[0])add(row('Источник','NFC '+s[0]+' · QR '+s[1]+' · ссылка '+s[2]));
if(D.a){const st=el('b','','★ '+String(D.a[0]).replace('.',','));st.style.color='#e5aa0c';add(row('Оценки гостей',el('span','',st,' ('+D.a[1]+')')));if(D.a[2])add(row('Недовольных',D.a[2]+(D.a[3]?' · '+D.a[3]:'')))}
if((D.k||[]).length)add(row('По картам','откр. / к отзыву'));(D.k||[]).forEach(k=>add(row(k[0],k[1]+' / '+k[2])));
if(!v[0]&&!c[0])add(el('div','m','Пока переходов не было.'));
if(D.b)add(el('div','w','⚠️ '+D.b));
if(D.u){const b=el('button','','Открыть статистику');b.addEventListener('click',()=>W&&W.openLink(D.u));add(b)}
}
A.addEventListener('click',ev=>{let t=ev.target;while(t&&t!==A&&!(t.dataset&&t.dataset.m))t=t.parentNode;if(t&&t!==A){mode=+t.dataset.m;draw();W&&W.HapticFeedback.selectionChanged()}});
if(W){W.onEvent('chatDataChanged',draw);draw();W.ready()}else draw();
</script>`;
