/* Cabecalho/menu compartilhado + tema. Requer auth.js carregado antes. */
(function(){ // aplica tema salvo o quanto antes (evita flash)
  var s=localStorage.getItem("ld-theme"); if(s) document.documentElement.setAttribute("data-theme",s);
})();

function toggleTheme(){
  var root=document.documentElement;
  var sysDark=matchMedia("(prefers-color-scheme:dark)").matches;
  var cur=root.getAttribute("data-theme")||(sysDark?"dark":"light");
  var next=cur==="dark"?"light":"dark";
  root.setAttribute("data-theme",next); localStorage.setItem("ld-theme",next);
}

function renderShell(){
  var el=document.getElementById("appbar"); if(!el) return;
  var u=(typeof AUTH!=="undefined")?AUTH.user():null;
  var here=location.pathname.split("/").pop()||"dashboard.html";
  var tabs=[["dashboard.html","Painel"],["index.html","Cadastro"],["consulta.html","Consulta"],
    ["governanca.html","Governança"],["versoes.html","Versões"],["editor.html","Editor"],
    ["auditoria.html","Auditoria"],["guia.html","Guia"]];
  var logo='<svg width="24" height="24" viewBox="0 0 32 32" fill="none" aria-hidden="true">'+
    '<rect x="1.4" y="1.4" width="29.2" height="29.2" rx="8" stroke="var(--color-primary)" stroke-width="2"/>'+
    '<rect x="7" y="8" width="12" height="2.6" rx="1.3" fill="var(--color-primary)"/>'+
    '<rect x="7" y="14.7" width="18" height="2.6" rx="1.3" fill="var(--color-primary)" opacity=".55"/>'+
    '<rect x="7" y="21.4" width="9" height="2.6" rx="1.3" fill="var(--color-primary)"/></svg>';
  var nav=tabs.map(function(t){
    return '<a class="navtab'+(t[0]===here?' active':'')+'" href="'+t[0]+'">'+t[1]+'</a>';}).join("");
  var user=u?'<div class="usermeta"><b>'+u.username+'</b>@'+u.tenant+'<br>'+(u.roles||[]).join(" · ")+'</div>':"";
  var moon='<svg class="moon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
  var sun='<svg class="sun" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2 6 6M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8"/></svg>';
  el.innerHTML='<div class="appbar"><div class="appbar-in">'+
    '<a class="brand" href="dashboard.html">'+logo+'Layout Dinâmico</a>'+
    '<nav class="navtabs" aria-label="Menu">'+nav+'</nav>'+
    '<div class="appbar-right">'+user+
      '<button class="btn icon-btn" id="themeBtn" type="button" aria-label="Alternar tema">'+moon+sun+'</button>'+
      (u?'<button class="btn btn-sm" id="logoutBtn" type="button">sair</button>':'')+
    '</div></div></div>';
  document.getElementById("themeBtn").addEventListener("click",toggleTheme);
  var lb=document.getElementById("logoutBtn"); if(lb) lb.addEventListener("click",function(){AUTH.logout();});
  var act=el.querySelector(".navtab.active"); if(act) act.scrollIntoView({block:"nearest",inline:"center"});
}

/* toast global */
function toast(msg){
  var t=document.getElementById("toast");
  if(!t){t=document.createElement("div");t.id="toast";document.body.appendChild(t);}
  t.textContent=msg;t.classList.add("show");
  clearTimeout(window.__tt);window.__tt=setTimeout(function(){t.classList.remove("show");},2200);
}

/* revela elementos .reveal ao rolar */
function initReveal(){
  var els=[].slice.call(document.querySelectorAll(".reveal"));
  if(matchMedia("(prefers-reduced-motion:reduce)").matches){els.forEach(function(e){e.classList.add("in");});return;}
  var io=new IntersectionObserver(function(en){en.forEach(function(e){
    if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target);}});},{rootMargin:"0px 0px -6% 0px",threshold:.06});
  els.forEach(function(e){io.observe(e);});
}

document.addEventListener("DOMContentLoaded",function(){ renderShell(); initReveal(); });
