#!/usr/bin/env python3
"""Собирает витрину myauto.tj (VIN-расшифровка, калькулятор растаможки, проверка штрафов) из прототипа.

Прототип prototype/index.html не меняется, результат пишется в public/index.html.
Запуск:  python3 tools/build.py [VIN_API]
VIN_API по умолчанию "same-origin": прокси в том же Worker, что и сайт (wrangler.jsonc).
Можно указать адрес отдельного прокси или "" (без прокси: только ISO 3779 и NHTSA, курс НБТ вручную).
"""
import pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "prototype" / "index.html"
OUT = ROOT / "public" / "index.html"
SITE = "https://myauto.tj"
VIN_API = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "same-origin"

html = SRC.read_text(encoding="utf-8")


def sub(old, new, count=1):
    global html
    n = html.count(old)
    if n != count:
        sys.exit(f"build: ожидалось {count} вхождений, найдено {n}: {old[:80]!r}")
    html = html.replace(old, new)


DESC = "Бесплатная расшифровка VIN, калькулятор растаможки и проверка штрафов ГАИ в Таджикистане: пошлина, акциз, НДС и утильсбор по ставкам 2026 года."
TITLE = "myauto.tj: проверка VIN и калькулятор растаможки"

# ---------- head: язык, title, SEO, превью для мессенджеров ----------
sub("<!doctype html><html><head>", '<!doctype html><html lang="ru"><head>')
sub("<title>myauto.tj</title>\n", "")
head = f"""<title>{TITLE}</title>
<meta name="description" content="{DESC}">
<link rel="canonical" href="{SITE}/">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#0B6E4F">
<meta property="og:type" content="website">
<meta property="og:site_name" content="myauto.tj">
<meta property="og:locale" content="ru_RU">
<meta property="og:url" content="{SITE}/">
<meta property="og:title" content="{TITLE}">
<meta property="og:description" content="{DESC}">
<meta property="og:image" content="{SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{{"@context":"https://schema.org","@type":"WebSite","name":"myauto.tj","url":"{SITE}/","inLanguage":["ru","tg"]}}</script>
"""
sub("</style></head>", "</style>\n" + head + "</head>")

# ---------- режим витрины ----------
sub("const T = {", "const SHOWCASE=true;\nconst T = {")
# "same-origin": сайт и прокси в одном Worker (site-worker.js), запросы идут на тот же адрес
sub('const VIN_API="";', 'const VIN_API=location.origin;' if VIN_API == "same-origin" else f'const VIN_API="{VIN_API}";')

OVR = r"""if(SHOWCASE){
  Object.assign(T,{
    hero:["Проверка авто <em>по VIN</em> и расчёт растаможки","Санҷиши мошин <em>аз рӯи VIN</em> ва ҳисоби гумрук"],
    vin_promo_t:["Расшифровка VIN бесплатно","Рамзкушоии VIN ройгон"],
    vin_promo_p:["Марка, модель, год, завод и двигатель по коду VIN. История ДТП и пробега появится после подключения баз.","Тамға, модел, сол, завод ва муҳаррик аз рӯи рамзи VIN. Таърихи садама ва масофа баъди пайваст шудани базаҳо илова мешавад."],
    vin_p:["Введите 17 символов VIN. Расшифруем марку, модель, год и завод. История ДТП и пробега пока не проверяется.","17 аломати VIN-ро ворид кунед. Тамға, модел, сол ва заводро муайян мекунем. Таърихи садама ва масофа ҳоло санҷида намешавад."],
    rate_note:["Курс НБТ проверяйте на nbt.tj: расчёт справочный.","Қурби БМТ-ро дар nbt.tj санҷед: ҳисоб тахминӣ аст."],
    sc_sub:["Бесплатно и без регистрации. Объявления о продаже машин скоро.","Ройгон ва бе бақайдгирӣ. Эълонҳои фурӯши мошин ба наздикӣ."],
    sc_calc:["Рассчитать растаможку","Ҳисоб кардани гумрук"],
    privacy:["Конфиденциальность","Махфият"]
  });
}
const INFO="""
sub("const INFO=", OVR)

INFO_OVR = r"""
if(SHOWCASE){
  INFO.about=["О проекте",()=>R("myauto.tj — бесплатная расшифровка VIN и калькулятор растаможки для Таджикистана. Скоро здесь появятся объявления о продаже машин и проверка истории по VIN.","myauto.tj — рамзкушоии ройгони VIN ва ҳисобкунаки гумрук барои Тоҷикистон. Ба наздикӣ эълонҳои фурӯши мошин ва санҷиши таърих аз рӯи VIN илова мешаванд.")];
  INFO.privacy=[()=>R("Конфиденциальность","Махфият"),()=>R("Регистрация не нужна, мы не собираем имена и телефоны. Введённый VIN отправляется в базы расшифровки (NHTSA, 17Vin) только для ответа на ваш запрос. Фото VIN обрабатывается на вашем устройстве и никуда не отправляется. Язык, тема и последний VIN хранятся в вашем браузере.","Бақайдгирӣ лозим нест, мо ном ва рақами телефонро ҷамъ намекунем. VIN танҳо барои ҷавоб ба дархости шумо ба базаҳои рамзкушоӣ (NHTSA, 17Vin) фиристода мешавад. Акси VIN дар дастгоҳи шумо коркард мешавад. Забон, мавзӯъ ва VIN-и охирин дар браузери шумо нигоҳ дошта мешаванд.")];
}
function openInfo(k){"""
sub("function openInfo(k){", INFO_OVR)
sub("function openInfo(k){const it=INFO[k];if(!it)return;sheet(`<h3>${it[0]}</h3>",
    "function openInfo(k){const it=INFO[k];if(!it)return;sheet(`<h3>${typeof it[0]===\"function\"?it[0]():it[0]}</h3>")

# все VIN идут в честную расшифровку, демо-отчёты с выдуманной историей не показываются
sub("if(!DEMO_VINS.has(vin)){REPORT=", "if(SHOWCASE||!DEMO_VINS.has(vin)){REPORT=")

# только главная, VIN, отчёт, растаможка и штрафы; остальные адреса ведут на главную
sub('function route(){\n  const h=(location.hash||"").slice(1)||"home";',
    'function route(){\n  const h=(location.hash||"").slice(1)||"home";\n'
    '  if(SHOWCASE&&!["home","vin","report","customs","fines"].includes(h)){if(h!=="home")history.replaceState(null,"","#home");show("home");return;}')

# без claude.ai нет ИИ: не отсылаем посетителя «открыть сайт в Claude»
sub('D.aiNa?"ИИ-расшифровка работает, когда сайт открыт в Claude":""',
    'D.aiNa&&!SHOWCASE?"ИИ-расшифровка работает, когда сайт открыт в Claude":""')
sub("<b>Распознавание по фото недоступно здесь</b><div class=\"note\">Откройте сайт в Claude или введите VIN вручную.</div>",
    "<b>${SHOWCASE?\"Штрихкод VIN на фото не найден\":\"Распознавание по фото недоступно здесь\"}</b><div class=\"note\">${SHOWCASE?\"Снимите штрихкод VIN ближе (наклейка на стойке двери или под стеклом) или введите VIN вручную.\":\"Откройте сайт в Claude или введите VIN вручную.\"}</div>")

# база ДТП живёт только в браузере, в витрине её нет: не добавляем блок в PDF
sub("liveBlocks=function(S){const b=_liveBlocks(S);b.push(dtpPdfBlock(S.vin));return b};",
    "liveBlocks=function(S){const b=_liveBlocks(S);if(!SHOWCASE)b.push(dtpPdfBlock(S.vin));return b};")

# не подставляем демо-VIN в поле
sub('$("#vin").value=load("vin")||"5YJ3E1EA7KF317000";', '$("#vin").value=load("vin")||(SHOWCASE?"":"5YJ3E1EA7KF317000");')

# курс НБТ с прокси (/rate), если он развёрнут
RATE_JS = r"""document.body.classList.toggle("showcase",SHOWCASE);
if(SHOWCASE&&VIN_API)fetch(`${VIN_API}/rate`,{signal:AbortSignal.timeout(8000)}).then(r=>r.json()).then(j=>{
  if(!(j&&j.usd>0))return;const u=$("#c-usd"),e=$("#c-eur");
  if(!u.dataset.touched){u.value=String(j.usd).replace(".",",");if(j.eur>0)e.value=String(j.eur).replace(".",",");calcCompute();}
  $$('[data-i18n="c_rate_n"]').forEach(n=>n.textContent=R(`Курс НБТ на ${j.date}. Можно изменить.`,`Қурби БМТ барои ${j.date}. Метавонед иваз кунед.`));
}).catch(()=>{});
["c-usd","c-eur"].forEach(id=>$("#"+id).addEventListener("input",e=>e.target.dataset.touched=1));
applyLang(); route();"""
sub("applyLang(); route();\n</script>", RATE_JS + "\n</script>")

# ---------- разметка: CTA на главной, растаможка в нижнем меню, ссылка на конфиденциальность ----------
sub('<h1 data-i18n-html="hero">Машины Таджикистана <em>в одном месте</em></h1>',
    '<h1 data-i18n-html="hero">Машины Таджикистана <em>в одном месте</em></h1>\n'
    '      <p class="sc-only sc-sub" data-i18n="sc_sub"></p>\n'
    '      <div class="sc-only sc-cta"><button class="btn btn-accent" data-nav="vin" data-i18n="vin_check_btn">Проверить VIN</button>'
    '<button class="btn btn-line" data-nav="customs" data-i18n="sc_calc">Рассчитать растаможку</button></div>')
sub('<span>VIN</span></button>',
    '<span>VIN</span></button>\n  <button data-nav="customs" class="sc-only"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h2M14 11h2M8 15h2M14 15h2"/></svg><span data-i18n="nav_customs">Растаможка</span></button>\n'
    '  <button data-nav="fines" class="sc-only"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h4"/><circle cx="17" cy="17" r="0.5"/></svg><span data-i18n="nav_fines">Штрафы</span></button>')
sub('<button data-info="contacts">Контакты</button>',
    '<button data-info="contacts">Контакты</button><button class="sc-only" data-info="privacy" data-i18n="privacy">Конфиденциальность</button>')

CSS = """
/* ---------- витрина (build.py): прячем объявления, аккаунты, ДТП и демо ---------- */
.sc-only{display:none!important}
body.showcase .sc-only{display:revert!important}
body.showcase .sc-cta{display:flex!important;flex-wrap:wrap;gap:10px;position:relative;z-index:1}
body.showcase .sc-sub{position:relative;z-index:1;margin:-4px 0 4px;color:rgba(255,255,255,.82);font-size:15px;max-width:52ch}
body.showcase .sc-cta .btn-line{color:#fff;border-color:rgba(255,255,255,.5);background:transparent}
body.showcase .hero .count,body.showcase #qform,body.showcase #chips-fuel,body.showcase #chips-cus,
body.showcase #cats,body.showcase #v-home .stack>div:has(#newgrid),body.showcase .evband,body.showcase .dtpband,
body.showcase #v-home .stack>div:has(#brands),body.showcase #v-home .stack>div:has(#vipgrid),body.showcase .vinpromo .demo>:not(.btn),
body.showcase nav.main [data-nav=search],body.showcase nav.main [data-nav=dtp],body.showcase #acct,body.showcase #post-btn,
body.showcase .tabbar [data-nav=search],body.showcase #post-tab,body.showcase #fav-tab,
body.showcase footer [data-nav=search],body.showcase footer [data-nav=dtp],body.showcase footer [data-post],
body.showcase footer [data-info=rules],body.showcase footer [data-info=prices],
body.showcase #v-vin .examples,body.showcase .dtp-vinlink,body.showcase #v-vin .stack>div:has(#geo),body.showcase #sec-dtp{display:none!important}
body.showcase .vinpromo .demo{background:none;padding:0;align-content:center}
body.showcase .tabbar{grid-template-columns:repeat(4,1fr)}
body.showcase .fn-examples{display:none!important}
body.showcase .tabbar .sc-only{display:flex!important}
body.showcase footer .sc-only{display:block!important}
"""
# CSS только в основной <style> после <title>: первый блок — служебный сброс
sub("/* Layout: sticky header,", CSS + "/* Layout: sticky header,")

# категории на главной скрыты: их картинки (~125 КБ base64) витрине не нужны
import re
html, n = re.subn(r'(const CAT_IMG=\{[^}]*\})', lambda m: re.sub(r'data:image/[a-z+]*;base64,[A-Za-z0-9+/=]+', '', m.group(1)), html, count=1)
if n != 1:
    sys.exit("build: CAT_IMG не найден")

OUT.write_text(html, encoding="utf-8")
print(f"OK: {OUT} ({len(html)//1024} КБ), VIN_API={VIN_API or '(пусто)'}")
