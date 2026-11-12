/**
 * The YOLKO logo for web pages: the Brush egg (one brush stroke that draws an egg, a yolk inside)
 * and the YOLKO name. Kanna picked it on 11 Nov 2026 and the "Yolk pen" motion on 12 Nov.
 *
 * The paths here are a light copy of the master logo (assets/brand/yolko-logo.svg): the brush
 * outline is fitted with 20 curves instead of 700 points, so a whole logo is about 2 KB inline.
 * build-pages.mjs writes it into every page's header and footer; the Worker uses it for its own
 * small pages. Keep this file free of Node and Worker APIs.
 *
 * Rules (brand guide): ink egg and name with a yellow yolk on white or cream, white egg and name
 * with the same yolk on black, never stretched, tilted or recoloured, never under 24px tall.
 */
export const LOGO = {
  w: 668.05,
  h: 186.08,
  eggW: 152.6,
  yolk: { cx: 78.97, cy: 113.92, r: 25.52, fill: "#ffd32a" },
  brush: "M19.3 148c-0.4-2.4-1.5-4.7-2.2-7.1c-1.5-4.6-2.6-9.3-3.3-14.2c-1.4-10.6-0.3-21.2 1-31.7c0.4-3.2 0.7-6.4 1.2-9.6c2.2-14.4 6.6-28.6 14.2-41.1c5.5-9 12.7-17.2 21.9-22.7c22.6-13.5 47.4-5.6 63.4 13.8c15 18.1 21.4 42.4 23 65.5c0.6 8.6 0.7 17.2-1.2 25.7c-6.2 28.2-29.8 50-58.8 52.4c-13.5 1.1-27-2.2-38.7-9L38.3 172.3c38.5 28.7 89.7 10.3 107.9-32.3c6.5-15.1 7.4-30.1 6.2-46.3c-2.2-29.3-12.5-60.6-36.3-79.5c-6.2-5-13.2-8.9-20.7-11.3c-11.2-3.6-23.3-3.8-34.7-0.7c-37.8 10.3-56.1 51.6-60.2 87.5c-0.4 4.2-0.5 8.5-0.5 12.7c0.2 13.7 2.8 26.9 9.7 38.8c1.8 3 3.8 6.4 6.6 8.7z",
  name: "M229.2 143.5V99.8L195.9 43.5H219.7L243.9 85.9H235.4L259.4 43.5H283.2L250 99.7V143.5ZM338.6 145.1Q327.3 145.1 317.6 141.2Q308 137.3 300.8 130.2Q293.6 123.2 289.6 113.8Q285.6 104.4 285.6 93.4Q285.6 82.4 289.5 73Q293.5 63.6 300.6 56.6Q307.8 49.7 317.5 45.8Q327.2 41.9 338.6 41.9Q350 41.9 359.6 45.8Q369.3 49.7 376.5 56.6Q383.7 63.6 387.6 73Q391.6 82.4 391.6 93.4Q391.6 104.4 387.6 113.8Q383.5 123.2 376.4 130.2Q369.2 137.3 359.5 141.2Q349.8 145.1 338.6 145.1ZM338.6 126.3Q345.4 126.3 351.2 123.9Q357.1 121.5 361.5 117.1Q365.9 112.7 368.4 106.7Q370.8 100.7 370.8 93.4Q370.8 86.2 368.4 80.2Q365.9 74.2 361.5 69.8Q357.1 65.4 351.2 63Q345.4 60.7 338.6 60.7Q331.7 60.7 325.9 63Q320 65.4 315.6 69.8Q311.2 74.2 308.8 80.2Q306.4 86.2 306.4 93.4Q306.4 100.7 308.8 106.7Q311.2 112.7 315.6 117.1Q320 121.5 325.9 123.9Q331.7 126.3 338.6 126.3ZM405.4 143.5V43.5H426.2V125.4H468.4V143.5ZM477.8 143.5V43.5H498.6V93.5L492.8 91.5L532.8 43.5H558.9L519.2 91.3L520.5 76.5L559.6 143.5H535.4L510.9 101.2L498.6 116.1V143.5ZM615 145.1Q603.8 145.1 594.1 141.2Q584.4 137.3 577.2 130.2Q570.1 123.2 566 113.8Q562 104.4 562 93.4Q562 82.4 566 73Q569.9 63.6 577.1 56.6Q584.3 49.7 594 45.8Q603.6 41.9 615 41.9Q626.4 41.9 636.1 45.8Q645.8 49.7 653 56.6Q660.1 63.6 664.1 73Q668 82.4 668 93.4Q668 104.4 664 113.8Q660 123.2 652.8 130.2Q645.6 137.3 636 141.2Q626.3 145.1 615 145.1ZM615 126.3Q621.9 126.3 627.7 123.9Q633.5 121.5 638 117.1Q642.4 112.7 644.8 106.7Q647.2 100.7 647.2 93.4Q647.2 86.2 644.8 80.2Q642.4 74.2 638 69.8Q633.5 65.4 627.7 63Q621.9 60.7 615 60.7Q608.2 60.7 602.3 63Q596.5 65.4 592.1 69.8Q587.6 74.2 585.2 80.2Q582.8 86.2 582.8 93.4Q582.8 100.7 585.2 106.7Q587.6 112.7 592.1 117.1Q596.5 121.5 602.3 123.9Q608.2 126.3 615 126.3Z",
  // Only the motion needs these: the stroke's centre line and the whole egg outline.
  centre: "M17.8 148.9c-4.8-7.9-8.2-16.7-9.8-25.8c-4.9-27.5 3.8-67.1 20.8-89.7c23.2-30.8 62.2-35.5 89.4-6.8c23.7 25.1 34.9 77.2 22.9 109.5c-15.5 41.6-64.3 60-102.1 35.1",
  egg: "M76.3 7.4c38.3 0 69.6 40.9 69.6 102.1c0 40.4-31.2 73.1-69.6 73.1c-38.4 0-69.5-32.7-69.5-73.1c0-61.2 31.3-102.1 69.5-102.1z",
  markCx: 76.33,
};

const yolk = (id = "") => `<ellipse${id ? ` id="${id}"` : ""} cx="${LOGO.yolk.cx}" cy="${LOGO.yolk.cy}" rx="${LOGO.yolk.r}" ry="${LOGO.yolk.r}" fill="${LOGO.yolk.fill}"/>`;

/**
 * The page's first logo (the header). It also defines the two shapes, so every later logo on the
 * page (`logoReuse`) is three short tags. Ink follows the text colour (`fill: currentColor`).
 */
export function logoMaster(cls = "brand-logo") {
  return `<svg class="${cls}" viewBox="0 0 ${LOGO.w} ${LOGO.h}" fill="currentColor" aria-hidden="true" focusable="false"><defs><path id="yk-b" d="${LOGO.brush}"/><path id="yk-n" d="${LOGO.name}"/></defs><g id="yk-s"><use href="#yk-b"/></g>${yolk("yk-y")}<g id="yk-w"><use href="#yk-n"/></g></svg>`;
}

/** Another logo on a page that already has `logoMaster`. */
export function logoReuse(cls = "brand-logo") {
  return `<svg class="${cls}" viewBox="0 0 ${LOGO.w} ${LOGO.h}" fill="currentColor" aria-hidden="true" focusable="false"><use href="#yk-b"/>${yolk()}<use href="#yk-n"/></svg>`;
}

/** A logo that stands alone (pages with no header, the Worker's small pages). */
export function logoAlone(cls = "brand-logo", style = "") {
  return `<svg class="${cls}"${style ? ` style="${style}"` : ""} viewBox="0 0 ${LOGO.w} ${LOGO.h}" fill="currentColor" aria-hidden="true" focusable="false"><path d="${LOGO.brush}"/>${yolk()}<path d="${LOGO.name}"/></svg>`;
}

/** The egg without the name, for places where the name is already next to it. */
export function eggAlone(cls = "brand-egg") {
  return `<svg class="${cls}" viewBox="0 0 ${LOGO.eggW} ${LOGO.h}" fill="currentColor" aria-hidden="true" focusable="false"><path d="${LOGO.brush}"/>${yolk()}</svg>`;
}

/**
 * "Yolk pen", the logo's motion, for the header logo: the yolk is the brush. It paints the egg in
 * one stroke, glides to the centre and becomes the yolk, and the name slides out from behind the
 * egg. About two seconds, once per visit (sessionStorage), never with reduced motion, and never
 * when the tab opens in the background. The logo is complete in the HTML, so with no script, or
 * if anything here throws, it simply shows. Put this right after the header logo so the first
 * frame is set before the page first paints.
 */
export const LOGO_MOTION = `(function(){var d=document,s=d.getElementById("yk-s"),y=d.getElementById("yk-y"),w=d.getElementById("yk-w");if(!s||!y||!w||!window.requestAnimationFrame||d.hidden)return;try{if(matchMedia("(prefers-reduced-motion: reduce)").matches||sessionStorage.getItem("yk-logo"))return;sessionStorage.setItem("yk-logo","1")}catch(e){return}var made=[],u=w.firstElementChild,YX=${LOGO.yolk.cx},YY=${LOGO.yolk.cy},R1=${LOGO.yolk.r},R0=13,T0=.3,T1=2.18,K=1.45,END=2.85,t0=null,over=false;function done(){if(over)return;over=true;s.removeAttribute("mask");w.removeAttribute("mask");u.removeAttribute("transform");y.removeAttribute("transform");y.setAttribute("cx",YX);y.setAttribute("cy",YY);y.setAttribute("rx",R1);y.setAttribute("ry",R1);made.forEach(function(e){e.parentNode&&e.parentNode.removeChild(e)})}try{var NS="http://www.w3.org/2000/svg",defs=s.ownerSVGElement.querySelector("defs"),el=function(n,a,p){var e=d.createElementNS(NS,n);for(var k in a)e.setAttribute(k,a[k]);(p||defs).appendChild(e);if(!p)made.push(e);return e},clamp=function(x){return Math.min(1,Math.max(0,x))},P=function(t,a,b){return clamp((t-a)/(b-a))},bez=function(x1,y1,x2,y2){var cx=3*x1,bx=3*(x2-x1)-cx,ax=1-cx-bx,cy=3*y1,by=3*(y2-y1)-cy,ay=1-cy-by;return function(p){if(p<=0)return 0;if(p>=1)return 1;for(var lo=0,hi=1,t=p,i=0;i<32;i++){((ax*t+bx)*t+cx)*t<p?lo=t:hi=t;t=(lo+hi)/2}return((ay*t+by)*t+cy)*t}},spring=function(p,f,g){return p<=0?0:p>=1?1:1-Math.exp(-g*p)*Math.cos(f*Math.PI*p)},TR=bez(.46,0,.2,1),WE=bez(.22,.82,.2,1);var m1=el("mask",{id:"yk-m",maskUnits:"userSpaceOnUse",x:-30,y:-30,width:250,height:250}),c=el("path",{d:"${LOGO.centre}",stroke:"#fff","stroke-width":25,"stroke-linejoin":"round",fill:"none"},m1),m2=el("mask",{id:"yk-k",maskUnits:"userSpaceOnUse",x:-30,y:-30,width:740,height:250});el("rect",{x:${LOGO.markCx},y:-30,width:700,height:250,fill:"#fff"},m2);el("path",{d:"${LOGO.egg}",fill:"#000",stroke:"#000","stroke-width":25},m2);var L=c.getTotalLength(),E=c.getPointAtLength(L),E0=c.getPointAtLength(L-2),dx=E.x-E0.x,dy=E.y-E0.y,dl=Math.sqrt(dx*dx+dy*dy)||1,gp=el("path",{fill:"none",d:"M"+E.x+" "+E.y+"C"+(E.x+dx/dl*20)+" "+(E.y+dy/dl*20)+" "+(YX-32.6)+" "+(YY+22.9)+" "+YX+" "+YY}),L2=gp.getTotalLength(),TOT=L+L2;if(!(L>0&&L2>0))throw 0;c.setAttribute("stroke-dasharray",L+" "+L);var dist=function(t){return TR(P(t,T0,T1))*TOT},pos=function(q){return q<=L?c.getPointAtLength(Math.max(0,q)):gp.getPointAtLength(Math.min(L2,q-L))};for(var lo=T0,hi=T1,i=0;i<32;i++){var md=(lo+hi)/2;dist(md)<L?lo=md:hi=md}var tS=(lo+hi)/2;var frame=function(t){var q=dist(t),ps=Math.min(1,q/L);if(ps>=1)s.removeAttribute("mask");else{s.setAttribute("mask","url(#yk-m)");c.setAttribute("stroke-dashoffset",L*(1-ps))}var a=pos(q),b=pos(Math.min(TOT,q+1)),k=pos(Math.max(0,q-1)),v=(dist(t+.008)-dist(t-.008))/.016,grow=spring(P(t,tS,tS+1.05),1.7,6.5),R=R0*spring(P(t,0,.5),1.5,7)+(R1-R0)*grow,st=1+.34*clamp(v/660)*(1-.5*clamp(grow));y.setAttribute("cx",a.x);y.setAttribute("cy",a.y);y.setAttribute("rx",Math.max(0,R*st));y.setAttribute("ry",Math.max(0,R/Math.sqrt(st)));if(st>1.001)y.setAttribute("transform","rotate("+Math.atan2(b.y-k.y,b.x-k.x)*180/Math.PI+" "+a.x+" "+a.y+")");else y.removeAttribute("transform");var wp=P(t,tS+.08,tS+1.2);if(wp>=1){w.removeAttribute("mask");u.removeAttribute("transform")}else{w.setAttribute("mask","url(#yk-k)");u.setAttribute("transform","translate("+(-587*(1-WE(wp)))+" 0)")}};var tick=function(ts){if(over)return;if(t0===null)t0=ts;var t=(ts-t0)/1000*K;if(t>=END){done();return}frame(t);requestAnimationFrame(tick)};frame(0);requestAnimationFrame(tick);setTimeout(done,6000)}catch(e){done()}})();`;

/** Favicon, app icon and manifest links for a page's head. `a` maps a site path to a URL. */
export function iconLinks(a = (p) => `/${p}`) {
  return [
    `<link rel="icon" href="/favicon.ico" sizes="48x48">`,
    `<link rel="icon" type="image/svg+xml" href="${a(`assets/favicon.svg?v=${ICON_V}`)}">`,
    `<link rel="apple-touch-icon" href="${a(`assets/brand/apple-touch-icon.png?v=${ICON_V}`)}">`,
    `<link rel="manifest" href="/site.webmanifest">`,
  ];
}
export const ICON_V = "2";
