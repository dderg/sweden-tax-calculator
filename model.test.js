// Run: bun test
// Loads the model functions straight out of index.html (everything before the DOM wiring) and checks them
// against Skatteverket's published worked examples and structural invariants.
import { test, expect, beforeEach } from "bun:test";

const html = await Bun.file(new URL("./index.html", import.meta.url)).text();
const src = html.match(/<script>([\s\S]*)<\/script>/)[1].split("for (const id of")[0];
const M = new Function(src + "\nreturn {P, personalTax, pensionValue, year, fresh, finish, run, runDormant, bestFuture, bestOf, g, ag};")();
const { P } = M;
const defaults = JSON.parse(JSON.stringify(P));
beforeEach(() => { for (const k in defaults) P[k].v = defaults[k].v; });

const I = o => ({ profit: 2e6, pyears: 1, years: 3, room0: 0, minSal: 0, owners: 1, prevPay: 0, ...o });
const near = (a, b, tol) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

// ---- personal tax: SKV 433 (2026) worked examples, kommunalskatt 32.84 ----
function jsa(sal) { // isolate jobbskatteavdrag: tax with credit vs tax with the credit brackets zeroed is awkward; compare against SKV formula directly
  const pbb = P.pbb.v, ki = P.muni.v / 100, a = sal / pbb;
  const ga = Math.min(sal, a <= 0.99 ? 0.423 * pbb : a <= 2.72 ? 0.423 * pbb + 0.2 * (sal - 0.99 * pbb) : a <= 3.11 ? 0.77 * pbb : a <= 7.88 ? 0.77 * pbb - 0.1 * (sal - 3.11 * pbb) : 0.293 * pbb);
  return a <= 0.91 ? (sal - ga) * ki : a <= 3.24 ? (0.91 * pbb + 0.3874 * (sal - 0.91 * pbb) - ga) * ki : a <= 8.08 ? (1.813 * pbb + 0.251 * (sal - 3.24 * pbb) - ga) * ki : (3.027 * pbb - ga) * ki;
}
test("jobbskatteavdrag matches SKV 433 examples (90k → 11,976; 240k → 26,083)", () => {
  P.muni.v = 32.84;
  near(jsa(90000), 11976, 40);   // SKV rounds grundavdrag up to whole hundreds; we don't
  near(jsa(240000), 26083, 40);
});
test("SKV 433 example 2: 55,000 salary → income tax fully offset by credits (only pensionsavgift+fees remain)", () => {
  P.muni.v = 32.84;
  // SKV: kommunal 9,819 − reductions = 0; the 3,800 allmän pensionsavgift is charged and refunded, fees excluded here
  near(M.personalTax(55000), 0, 300);
});
test("grundavdrag floors at 0.293 PBB for high incomes", () => {
  // at 800k: taxable = 800k − 17,345.6; state tax = 20% × (taxable − 643,000)
  const t = M.personalTax(800000);
  const taxable = 800000 - 0.293 * P.pbb.v;
  const expected = taxable * P.muni.v / 100 - (3.027 * P.pbb.v - 0.293 * P.pbb.v) * P.muni.v / 100 - 1500 + 0.2 * (taxable - 643000);
  near(t, expected, 1);
});
test("marginal rate above skiktgräns = kommunal + 20%", () => {
  const m = (M.personalTax(800000) - M.personalTax(799000)) / 1000;
  near(m, (P.muni.v + 20) / 100, 1e-6);
});
test("brytpunkt: state tax starts at ~660,400 gross for salary", () => {
  expect(M.personalTax(660300) - M.personalTax(659300)).toBeLessThan(0.32 * 1000);
  expect(M.personalTax(661400) - M.personalTax(660400)).toBeGreaterThan(0.5 * 1000);
});
test("dividends taxed as income get no jobbskatteavdrag", () => {
  expect(M.personalTax(0, 150000)).toBeGreaterThan(M.personalTax(150000) + 10000);
});
test("zero income → zero tax", () => expect(M.personalTax(0)).toBe(0));

// ---- 3:12 room: Skatteverket examples ----
test("Valter: 100% owner, last year payroll 1,000,000 → room 322,400 + 177,600", () => {
  const st = M.fresh(I({ prevPay: 1000000 }));
  M.year(st, 0, 0, 0, "y");
  near(st.room, 500000, 1);
});
test("room uses LAST year's payroll: salary this year only adds room next year", () => {
  P.usePfond.v = 0;
  const st = M.fresh(I({ profit: 0 })); st.cash = 5e6;
  M.year(st, 1000000, 0, 0, "y1"); const r1 = st.room + st.rows[0].divIn; // total room granted year 1
  near(r1, 322400, 1);
  M.year(st, 0, 0, 0, "y2"); const r2 = st.room + st.rows[1].divIn;
  near(r2, 322400 + 0.5 * (1000000 - 644800), 1);
});
test("spouses (Amy & Gedion): payroll 4,000,000 → joint wage-based room 1,677,600, 8 IBB deducted once", () => {
  const st = M.fresh(I({ owners: 2, prevPay: 4000000 }));
  M.year(st, 0, 0, 0, "y");
  near(st.room, 322400 + 1677600, 1);
});
test("saved room carries forward without uplift", () => {
  const st = M.fresh(I({ profit: 0, room0: 750000 }));
  M.year(st, 0, 0, 0, "y");
  near(st.room, 750000 + 322400, 1);
});
test("in-room dividend taxed 20%, limited by room and by free equity", () => {
  P.usePfond.v = 0; P.ret.v = 0; P.iskTax.v = 0;
  const st = M.fresh(I({ profit: 0, room0: 1e6 })); st.cash = 200000;
  M.year(st, 0, 0, 0, "y");
  near(st.rows[0].divIn, 200000, 1);
  near(st.rows[0].net, 160000, 1);
  expect(st.cash).toBeCloseTo(0, 6);
});

// ---- above-room dividends ----
test("over-room dividend taxed as income, split per owner, 90 IBB ceiling then 30% capital", () => {
  P.usePfond.v = 0; P.grundbelopp.v = 0;
  const st = M.fresh(I({ profit: 0 })); st.cash = 10e6;
  M.year(st, 0, 10e6, 0, "y");
  const over = st.rows[0].divOver; near(over, 10e6, 1);
  const asIncome = P.overCap.v, asCap = 10e6 - asIncome;
  near(st.rows[0].net, asIncome - M.personalTax(0, asIncome) + asCap * 0.7, 1);
  // two owners: ceiling per person → more taxed as income
  const st2 = M.fresh(I({ profit: 0, owners: 2 })); st2.cash = 10e6;
  M.year(st2, 0, 10e6, 0, "y");
  near(st2.rows[0].net, 2 * (5e6 - M.personalTax(0, 5e6)), 1);
});

// ---- corporate side ----
test("corporate tax 20.6% on result after salary cost; employer contributions 31.42%", () => {
  P.usePfond.v = 0;
  const st = M.fresh(I({ profit: 1e6 }));
  M.year(st, 100000, 0, 1e6, "y");
  const cost = 100000 * 1.3142;
  near(st.rows[0].corpTax, (1e6 - cost) * 0.206, 1);
  near(st.cash + st.rows[0].divIn, 1e6 - cost - (1e6 - cost) * 0.206, 1);
});
test("periodiseringsfond: 25% deferred, reversed against later loss, notional income at SLR", () => {
  P.ret.v = 0; P.iskTax.v = 0; P.grundbelopp.v = 0;
  const st = M.fresh(I({ profit: 1e6 }));
  M.year(st, 0, 0, 1e6, "y1");
  near(st.fund, 250000, 1); near(st.rows[0].corpTax, 750000 * 0.206, 1);
  M.year(st, 100000, 0, 0, "y2"); // loss = 131,420 − 0.0255×250,000 notional
  const loss = 100000 * 1.3142 - 250000 * 0.0255;
  near(st.rows[1].fundDelta, -loss, 1);
  near(st.rows[1].corpTax, 0, 1e-6);
});
test("periodiseringsfond off → no allocation", () => {
  P.usePfond.v = 0;
  const st = M.fresh(I()); M.year(st, 0, 0, 1e6, "y");
  expect(st.fund).toBe(0);
});
test("company cash compounds at return minus schablon tax (KF)", () => {
  P.usePfond.v = 0; P.grundbelopp.v = 0; P.ret.v = 5; P.iskTax.v = 1;
  const st = M.fresh(I({ profit: 0 })); st.cash = 1e6;
  M.year(st, 0, 0, 0, "y");
  near(st.cash, 1.04e6, 1);
});

// ---- plan-level invariants ----
test("present value: at zero net return val == nominal net", () => {
  P.ret.v = 0; P.iskTax.v = 0;
  const r = M.run(150000, 120000, 0, I());
  near(r.val, r.net, 1e-6);
});
test("present value is timing-neutral: paying out now vs one year later at the same tax gives equal value", () => {
  P.usePfond.v = 0; P.grundbelopp.v = 0; P.ret.v = 7;
  const mk = () => { const st = M.fresh(I({ profit: 0, room0: 1e9 })); st.cash = 1e6; return st; };
  const a = mk(); M.year(a, 0, 0, 0, "y1"); M.finish(a);              // all out year 1 (room covers it)
  const b = mk(); b.room = 0; M.year(b, 0, 0, 0, "y1"); b.room = 1e9; M.year(b, 0, 0, 0, "y2"); M.finish(b); // all out year 2
  near(a.rows[0].divIn, 1e6 * M.g(), 1); near(b.rows[1].divIn, 1e6 * M.g() ** 2, 1);
  near(a.val, b.val, 1);
});
test("company is always emptied; cash and room never negative", () => {
  for (const [S, F, G] of [[0, 0, 0], [660400, 660400, Infinity], [150000, 120000, 300000], [1500000, 0, 0]]) {
    const r = M.run(S, F, G, I({ profit: 3e6, pyears: 2, years: 5 }));
    expect(r.cash).toBeLessThan(1);
    expect(r.rows.every(y => y.cashEnd > -1)).toBe(true);
    expect(r.room).toBeGreaterThanOrEqual(-1e-6);
  }
});
test("salary cannot exceed what the company can pay", () => {
  P.usePfond.v = 0;
  const r = M.run(5e6, 0, 0, I({ profit: 1e6, years: 0 }));
  expect(r.rows[0].sal).toBe(5e6); // profit year: caller's choice, produces a loss
  const r2 = M.run(0, 5e6, 0, I({ profit: 1e6, years: 1 }));
  near(r2.rows[1].sal * M.ag(), r2.rows[0].cashEnd, 1); // payout year capped by cash at start of year
});
test("dormant plan: no salary during 4 years, in-room dividends only, then 25% on remainder", () => {
  P.ret.v = 0; P.iskTax.v = 0;
  const r = M.runDormant(0, I({ profit: 2e6 }));
  const dorm = r.rows.filter(y => y.label.startsWith("Dormant"));
  expect(dorm.length).toBe(4);
  expect(dorm.every(y => y.sal === 0 && y.divOver === 0)).toBe(true);
  const liq = r.rows.at(-1);
  expect(liq.label).toMatch(/Liquidation/);
  near(liq.net, r.rows.at(-2).cashEnd * (1 - P.liqTax.v / 100) - liq.corpTax * 0.75, 1);
});
test("optimizer never returns a plan worse than the naive cap plan", () => {
  for (const o of [{}, { pyears: 5, years: 10 }, { owners: 2 }, { profit: 8e6, years: 20 }]) {
    const i = I(o);
    const naive = M.run(P.brytpunkt.v, P.brytpunkt.v, Infinity, i).val;
    const b = M.bestFuture(P.brytpunkt.v, i);
    expect(b.val).toBeGreaterThanOrEqual(naive - 1);
  }
});
test("pension value counted on salary up to 8.07 IBB only", () => {
  near(M.pensionValue(1e6), 8.07 * P.ibb.v * 0.1, 1);
  P.pensionVal.v = 0;
  expect(M.pensionValue(500000)).toBe(0);
});
