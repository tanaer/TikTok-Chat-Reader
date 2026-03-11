import { useState } from 'react';
import { Calculator, Link, Plus, Trash2, Save, Upload, Download } from 'lucide-react';

interface CostItem {
  id: string;
  name: string;
  amount: number;
  type: 'labor' | 'operating';
}

interface TieredRate {
  min: number;
  max: number;
  rate: number;
}

const DEFAULT_ANCHOR_RATES: TieredRate[] = [
  { min: 0, max: 100000, rate: 20 },
  { min: 100000, max: 200000, rate: 22 },
  { min: 200000, max: 300000, rate: 24 },
  { min: 300000, max: Infinity, rate: 25 },
];

const DEFAULT_HOST_RATES: TieredRate[] = [
  { min: 0, max: 200000, rate: 5 },
  { min: 200000, max: 400000, rate: 6 },
  { min: 400000, max: 600000, rate: 7 },
  { min: 600000, max: Infinity, rate: 7 },
];

const DEFAULT_OPERATOR_RATES: TieredRate[] = [
  { min: 0, max: 200000, rate: 0 },
  { min: 200000, max: 400000, rate: 0.5 },
  { min: 400000, max: 600000, rate: 1 },
  { min: 600000, max: Infinity, rate: 1 },
];

const DEFAULT_COSTS: CostItem[] = [
  { id: '1', name: '运营', amount: 6000, type: 'labor' },
  { id: '2', name: '舞蹈老师', amount: 6000, type: 'labor' },
  { id: '3', name: '妆造师', amount: 8000, type: 'labor' },
  { id: '4', name: '房租', amount: 6000, type: 'operating' },
  { id: '5', name: '设备折旧', amount: 4000, type: 'operating' },
  { id: '6', name: '线路费用', amount: 3000, type: 'operating' },
  { id: '7', name: '行政费用', amount: 3000, type: 'operating' },
];

function getTieredRate(rates: TieredRate[], amount: number): number {
  for (const tier of rates) {
    if (amount >= tier.min && amount < tier.max) return tier.rate;
  }
  return rates[rates.length - 1].rate;
}

function calculateTieredByFlow(rates: TieredRate[], monthlyFlow: number): number {
  let commission = 0, remaining = monthlyFlow;
  for (const tier of rates) {
    if (remaining <= 0) break;
    const tierRange = tier.max === Infinity ? remaining : tier.max - tier.min;
    commission += Math.min(remaining, tierRange) * (tier.rate / 100);
    remaining -= Math.min(remaining, tierRange);
  }
  return commission;
}

function calculateTieredByRevenue(rates: TieredRate[], revenueCNY: number): number {
  let commission = 0, remaining = revenueCNY;
  for (const tier of rates) {
    if (remaining <= 0) break;
    const tierRange = tier.max === Infinity ? remaining : tier.max - tier.min;
    commission += Math.min(remaining, tierRange) * (tier.rate / 100);
    remaining -= Math.min(remaining, tierRange);
  }
  return commission;
}

export default function App() {
  const [anchorCount, setAnchorCount] = useState(4);
  const [exchangeRate, setExchangeRate] = useState(6.9);
  const [dailyTarget, setDailyTarget] = useState(11000);
  const [anchorRates, setAnchorRates] = useState<TieredRate[]>(DEFAULT_ANCHOR_RATES);
  const [hostRates, setHostRates] = useState<TieredRate[]>(DEFAULT_HOST_RATES);
  const [operatorRates, setOperatorRates] = useState<TieredRate[]>(DEFAULT_OPERATOR_RATES);
  const [hrRate, setHrRate] = useState(1);
  const [costs, setCosts] = useState<CostItem[]>(DEFAULT_COSTS);
  const [currentConfigName, setCurrentConfigName] = useState('默认配置');
  const [isGuaranteePeriod, setIsGuaranteePeriod] = useState(true);
  const [anchorGuarantee, setAnchorGuarantee] = useState(8000);
  const [hostGuarantee, setHostGuarantee] = useState(6500);
  const [requiredHours, setRequiredHours] = useState(156);
  const [actualHours, setActualHours] = useState(156);

  const monthlyFlow = dailyTarget * 26;
  const revenueCNY = (monthlyFlow / 100) * exchangeRate;
  const perAnchorRevenue = revenueCNY / anchorCount; // 主播个人营收
  
  const anchorCommissionCNY = calculateTieredByRevenue(anchorRates, perAnchorRevenue) * anchorCount; // 按个人营收计算，乘以人数
  const hostCommissionCNY = calculateTieredByRevenue(hostRates, revenueCNY);
  const operatorCommissionCNY = calculateTieredByRevenue(operatorRates, revenueCNY);
  const hrCommission = revenueCNY * (hrRate / 100);
  
  const guaranteeRatio = actualHours / requiredHours;
  const anchorGuaranteePerPerson = anchorGuarantee * guaranteeRatio;
  const totalAnchorGuarantee = anchorGuaranteePerPerson * anchorCount;
  const hostGuaranteeTotal = hostGuarantee * guaranteeRatio;
  
  const anchorFinalPay = isGuaranteePeriod ? (anchorCommissionCNY < totalAnchorGuarantee ? totalAnchorGuarantee : anchorCommissionCNY) : anchorCommissionCNY;
  const hostFinalPay = isGuaranteePeriod ? (hostCommissionCNY < hostGuaranteeTotal ? hostGuaranteeTotal : hostCommissionCNY) : hostCommissionCNY;
  
  const anchorSubsidy = isGuaranteePeriod && anchorCommissionCNY < totalAnchorGuarantee ? totalAnchorGuarantee - anchorCommissionCNY : 0;
  const hostSubsidy = isGuaranteePeriod && hostCommissionCNY < hostGuaranteeTotal ? hostGuaranteeTotal - hostCommissionCNY : 0;
  
  // 保底补偿算入固定开支
  const laborCosts = costs.filter(c => c.type === 'labor').reduce((sum, c) => sum + c.amount, 0);
  const operatingCosts = costs.filter(c => c.type === 'operating').reduce((sum, c) => sum + c.amount, 0);
  // 保底期：固定开支包含保底金额；转正后：固定开支只包含保底补偿（提成不够的部分）
  const fixedCosts = isGuaranteePeriod 
    ? laborCosts + operatingCosts + totalAnchorGuarantee + hostGuaranteeTotal
    : laborCosts + operatingCosts + anchorSubsidy + hostSubsidy;
  const totalCommissionsCNY = anchorFinalPay + hostFinalPay + operatorCommissionCNY + hrCommission;
  const companyProfit = revenueCNY - totalCommissionsCNY - fixedCosts;
  
  const anchorRate = getTieredRate(anchorRates, perAnchorRevenue);
  const hostRate = getTieredRate(hostRates, revenueCNY);
  const operatorRate = getTieredRate(operatorRates, revenueCNY);

  const addCost = (type: 'labor' | 'operating') => setCosts([...costs, { id: Date.now().toString(), name: type === 'labor' ? '新人力成本' : '新运营成本', amount: 0, type }]);
  const updateCost = (id: string, field: keyof CostItem, value: string | number) => setCosts(costs.map(c => c.id === id ? { ...c, [field]: field === 'amount' ? Number(value) : value } : c));
  const removeCost = (id: string) => setCosts(costs.filter(c => c.id !== id));
  const updateTierRate = (type: 'anchor' | 'host' | 'operator', index: number, field: keyof TieredRate, value: string | number) => {
    const setter = type === 'anchor' ? setAnchorRates : type === 'host' ? setHostRates : setOperatorRates;
    const rates = type === 'anchor' ? anchorRates : type === 'host' ? hostRates : operatorRates;
    setter(rates.map((r, i) => i === index ? { ...r, [field]: Number(value) } : r));
  };
  const saveConfig = () => { localStorage.setItem('tuangu_config', JSON.stringify({ name: currentConfigName, anchorCount, exchangeRate, anchorRates, hostRates, operatorRates, hrRate, costs, isGuaranteePeriod, anchorGuarantee, hostGuarantee, requiredHours, actualHours })); alert(`配置 "${currentConfigName}" 已保存！`); };
  const exportConfig = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ anchorCount, exchangeRate, anchorRates, hostRates, operatorRates, hrRate, costs, isGuaranteePeriod, anchorGuarantee, hostGuarantee, requiredHours, actualHours }, null, 2)], { type: 'application/json' })); a.download = 'tuangu_config.json'; a.click(); };
  const importConfig = (e: React.ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = (ev) => { try { const d = JSON.parse(ev.target?.result as string); setAnchorCount(d.anchorCount||4); setExchangeRate(d.exchangeRate||6.9); setAnchorRates(d.anchorRates||DEFAULT_ANCHOR_RATES); setHostRates(d.hostRates||DEFAULT_HOST_RATES); setOperatorRates(d.operatorRates||DEFAULT_OPERATOR_RATES); setHrRate(d.hrRate||1); setCosts(d.costs||DEFAULT_COSTS); setIsGuaranteePeriod(d.isGuaranteePeriod??true); setAnchorGuarantee(d.anchorGuarantee||8000); setHostGuarantee(d.hostGuarantee||6500); setRequiredHours(d.requiredHours||156); setActualHours(d.actualHours||156); alert('导入成功!'); } catch { alert('格式错误!'); } }; reader.readAsText(file); };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 p-4 md:p-6">
      <div className="max-w-7xl mx-auto">
        <header className="text-center mb-6">
          <h1 className="text-3xl font-bold text-white mb-2 flex items-center justify-center gap-3"><Calculator className="w-8 h-8 text-purple-400" />团播运营计算器</h1>
          <p className="text-slate-400 text-sm">调整参数，自动计算公司毛利</p>
        </header>
        <div className="grid lg:grid-cols-4 gap-6">
          <div className="lg:col-span-1 space-y-4">
            <div className="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-3">基础参数</h2>
              <div className="space-y-3">
                <div className="flex items-center justify-between"><label className="text-slate-300 text-sm">主播人数</label><input type="number" min="1" value={anchorCount} onChange={(e) => setAnchorCount(Number(e.target.value))} className="w-20 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-white text-right" /></div>
                <div className="flex items-center justify-between"><label className="text-slate-300 text-sm">汇率(美元兑CNY)</label><input type="number" step="0.1" value={exchangeRate} onChange={(e) => setExchangeRate(Number(e.target.value))} className="w-20 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-white text-right" /></div>
                <div className="flex items-center justify-between"><label className="text-slate-300 text-sm">HR团队提成</label><div className="flex items-center gap-1"><input type="number" step="0.1" value={hrRate} onChange={(e) => setHrRate(Number(e.target.value))} className="w-16 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-white text-right" /><span className="text-slate-400 text-sm">%</span></div></div>
              </div>
            </div>
            <div className="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-3">主播保底设置</h2>
              <div className="space-y-3">
                <div className="flex items-center justify-between"><label className="text-slate-300 text-sm">是否在保底期</label><button onClick={() => setIsGuaranteePeriod(!isGuaranteePeriod)} className={"px-3 py-1 rounded-lg text-sm font-medium " + (isGuaranteePeriod ? 'bg-green-600 text-white' : 'bg-slate-600 text-slate-300')}>{isGuaranteePeriod ? '保底中' : '已转正'}</button></div>
                <div className="flex items-center justify-between"><label className="text-slate-300 text-sm">主持保底金额(元)</label><input type="number" value={hostGuarantee} onChange={(e) => setHostGuarantee(Number(e.target.value))} className="w-24 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-white text-right" /></div>
                <div className="flex items-center justify-between"><label className="text-slate-300 text-sm">主播保底金额(元/人)</label><input type="number" value={anchorGuarantee} onChange={(e) => setAnchorGuarantee(Number(e.target.value))} className="w-24 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-white text-right" /></div>
                <div className="flex items-center justify-between"><label className="text-slate-300 text-sm">要求时长(小时)</label><input type="number" value={requiredHours} onChange={(e) => setRequiredHours(Number(e.target.value))} className="w-24 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-white text-right" /></div>
                <div className="flex items-center justify-between"><label className="text-slate-300 text-sm">实际时长(小时)</label><input type="number" value={actualHours} onChange={(e) => setActualHours(Number(e.target.value))} className="w-24 bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-white text-right" /></div>
                {isGuaranteePeriod && <div className="pt-2 border-t border-slate-600 text-xs text-slate-400">时长比例: {(guaranteeRatio * 100).toFixed(1)}%<br/>每人保底: {anchorGuaranteePerPerson.toFixed(0)} 元</div>}
              </div>
            </div>
            <div className="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
              <div className="flex items-center justify-between mb-3"><h2 className="text-lg font-semibold text-white">人力成本</h2><button onClick={() => addCost('labor')} className="p-1 bg-purple-600 rounded hover:bg-purple-500"><Plus className="w-4 h-4 text-white" /></button></div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {costs.filter(c => c.type === 'labor').map(cost => (<div key={cost.id} className="flex items-center gap-2"><input type="text" value={cost.name} onChange={(e) => updateCost(cost.id, 'name', e.target.value)} className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-white text-sm" /><input type="number" value={cost.amount} onChange={(e) => updateCost(cost.id, 'amount', e.target.value)} className="w-20 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-white text-right text-sm" /><button onClick={() => removeCost(cost.id)} className="p-1 text-red-400 hover:text-red-300"><Trash2 className="w-4 h-4" /></button></div>))}
              </div>
              <div className="mt-2 pt-2 border-t border-slate-700 text-sm text-slate-400">合计: {laborCosts.toLocaleString()} 元</div>
            </div>
            <div className="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
              <div className="flex items-center justify-between mb-3"><h2 className="text-lg font-semibold text-white">运营成本</h2><button onClick={() => addCost('operating')} className="p-1 bg-blue-600 rounded hover:bg-blue-500"><Plus className="w-4 h-4 text-white" /></button></div>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {costs.filter(c => c.type === 'operating').map(cost => (<div key={cost.id} className="flex items-center gap-2"><input type="text" value={cost.name} onChange={(e) => updateCost(cost.id, 'name', e.target.value)} className="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-white text-sm" /><input type="number" value={cost.amount} onChange={(e) => updateCost(cost.id, 'amount', e.target.value)} className="w-20 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-white text-right text-sm" /><button onClick={() => removeCost(cost.id)} className="p-1 text-red-400 hover:text-red-300"><Trash2 className="w-4 h-4" /></button></div>))}
              </div>
              <div className="mt-2 pt-2 border-t border-slate-700 text-sm text-slate-400">合计: {operatingCosts.toLocaleString()} 元</div>
            </div>
            <div className="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-3">配置管理</h2>
              <div className="space-y-2">
                <input type="text" value={currentConfigName} onChange={(e) => setCurrentConfigName(e.target.value)} placeholder="配置名称" className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white" />
                <div className="flex gap-2">
                  <button onClick={saveConfig} className="flex-1 flex items-center justify-center gap-1 bg-green-600 hover:bg-green-500 rounded-lg px-3 py-2 text-white text-sm"><Save className="w-4 h-4" /> 保存</button>
                  <button onClick={exportConfig} className="flex-1 flex items-center justify-center gap-1 bg-blue-600 hover:bg-blue-500 rounded-lg px-3 py-2 text-white text-sm"><Download className="w-4 h-4" /> 导出</button>
                  <label className="flex-1 flex items-center justify-center gap-1 bg-purple-600 hover:bg-purple-500 rounded-lg px-3 py-2 text-white text-sm cursor-pointer"><Upload className="w-4 h-4" /> 导入<input type="file" accept=".json" onChange={importConfig} className="hidden" /></label>
                </div>
              </div>
            </div>
          </div>
          <div className="lg:col-span-1 space-y-4">
            <div className="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-3">主播阶梯分成(万CNY)</h2>
              <div className="space-y-2 text-sm">
                <div className="flex items-center text-slate-400 text-xs"><span className="w-16">区间(万)</span><span className="flex-1 text-right">提成%</span></div>
                {anchorRates.map((tier, idx) => (<div key={idx} className="flex items-center gap-1"><input type="number" value={tier.min / 10000} onChange={(e) => updateTierRate('anchor', idx, 'min', Number(e.target.value) * 10000)} className="w-14 bg-slate-700 border border-slate-600 rounded px-1 py-1 text-white text-xs text-right" /><span className="text-slate-500">-</span><input type="number" value={tier.max === Infinity ? '' : tier.max / 10000} onChange={(e) => updateTierRate('anchor', idx, 'max', e.target.value === '' ? Infinity : Number(e.target.value) * 10000)} className="w-14 bg-slate-700 border border-slate-600 rounded px-1 py-1 text-white text-xs text-right" placeholder="∞" /><input type="number" value={tier.rate} onChange={(e) => updateTierRate('anchor', idx, 'rate', e.target.value)} className="w-12 bg-slate-700 border border-slate-600 rounded px-1 py-1 text-white text-xs text-right" /><span className="text-slate-400 text-xs">%</span></div>))}
                <div className="mt-2 pt-2 border-t border-slate-700 text-right text-orange-400 text-xs">当前: {anchorRate}%</div>
              </div>
            </div>
            <div className="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-3">主持阶梯分成(万CNY)</h2>
              <div className="space-y-2 text-sm">
                <div className="flex items-center text-slate-400 text-xs"><span className="w-16">区间(万)</span><span className="flex-1 text-right">提成%</span></div>
                {hostRates.map((tier, idx) => (<div key={idx} className="flex items-center gap-1"><input type="number" value={tier.min / 10000} onChange={(e) => updateTierRate('host', idx, 'min', Number(e.target.value) * 10000)} className="w-14 bg-slate-700 border border-slate-600 rounded px-1 py-1 text-white text-xs text-right" /><span className="text-slate-500">-</span><input type="number" value={tier.max === Infinity ? '' : tier.max / 10000} onChange={(e) => updateTierRate('host', idx, 'max', e.target.value === '' ? Infinity : Number(e.target.value) * 10000)} className="w-14 bg-slate-700 border border-slate-600 rounded px-1 py-1 text-white text-xs text-right" placeholder="∞" /><input type="number" value={tier.rate} onChange={(e) => updateTierRate('host', idx, 'rate', e.target.value)} className="w-12 bg-slate-700 border border-slate-600 rounded px-1 py-1 text-white text-xs text-right" /><span className="text-slate-400 text-xs">%</span></div>))}
                <div className="mt-2 pt-2 border-t border-slate-700 text-right text-blue-400 text-xs">当前: {hostRate}% (营收{Math.round(revenueCNY/10000)}万)</div>
              </div>
            </div>
            <div className="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-3">运营阶梯分成(万CNY)</h2>
              <div className="space-y-2 text-sm">
                <div className="flex items-center text-slate-400 text-xs"><span className="w-16">区间(万)</span><span className="flex-1 text-right">提成%</span></div>
                {operatorRates.map((tier, idx) => (<div key={idx} className="flex items-center gap-1"><input type="number" value={tier.min / 10000} onChange={(e) => updateTierRate('operator', idx, 'min', Number(e.target.value) * 10000)} className="w-14 bg-slate-700 border border-slate-600 rounded px-1 py-1 text-white text-xs text-right" /><span className="text-slate-500">-</span><input type="number" value={tier.max === Infinity ? '' : tier.max / 10000} onChange={(e) => updateTierRate('operator', idx, 'max', e.target.value === '' ? Infinity : Number(e.target.value) * 10000)} className="w-14 bg-slate-700 border border-slate-600 rounded px-1 py-1 text-white text-xs text-right" placeholder="∞" /><input type="number" value={tier.rate} onChange={(e) => updateTierRate('operator', idx, 'rate', e.target.value)} className="w-12 bg-slate-700 border border-slate-600 rounded px-1 py-1 text-white text-xs text-right" /><span className="text-slate-400 text-xs">%</span></div>))}
                <div className="mt-2 pt-2 border-t border-slate-700 text-right text-green-400 text-xs">当前: {operatorRate}% (营收{Math.round(revenueCNY/10000)}万)</div>
              </div>
            </div>
          </div>
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-3">目标流水设置</h2>
              <div className="flex items-center gap-4">
                <label className="text-slate-300 text-sm whitespace-nowrap">日均流水目标：</label>
                <input type="range" min="2000" max="500000" step="1000" value={dailyTarget} onChange={(e) => setDailyTarget(Number(e.target.value))} className="flex-1 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer" />
                <div className="w-28 bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-white text-right font-mono">{dailyTarget.toLocaleString()}</div>
              </div>
              <div className="mt-2 text-center text-slate-400 text-sm">月流水: {monthlyFlow.toLocaleString()} 钻 | 营业收入: {Math.round(revenueCNY).toLocaleString()} 元</div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-gradient-to-br from-purple-600 to-purple-700 rounded-xl p-4 text-white">
                <div className="text-purple-200 text-sm mb-1">营业收入</div>
                <div className="text-2xl font-bold">{Math.round(revenueCNY).toLocaleString()}</div>
                <div className="text-purple-200 text-sm">元/月</div>
              </div>
              <div className="bg-gradient-to-br from-slate-600 to-slate-700 rounded-xl p-4 text-white">
                <div className="text-slate-300 text-sm mb-1">固定开支</div>
                <div className="text-2xl font-bold">{fixedCosts.toLocaleString()}</div>
                <div className="text-slate-300 text-sm">元/月</div>
              </div>
            </div>
            <div className="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-3">分成明细</h2>
              <div className="space-y-2">
                <div className={"p-2 rounded-lg " + (isGuaranteePeriod && anchorSubsidy > 0 ? 'bg-amber-900/40 border border-amber-600' : 'bg-orange-900/30')}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-orange-400">主播</span>
                      <span className="text-slate-400 text-xs">({anchorRate}%,营收)</span>
                      {isGuaranteePeriod && <span className="px-1.5 py-0.5 bg-amber-600 text-white text-xs rounded">保底</span>}
                    </div>
                    <div className="text-right">
                      <div className="text-orange-400 font-bold">{Math.round(anchorFinalPay).toLocaleString()} 元</div>
                      <div className="text-slate-400 text-xs">分成: {Math.round(anchorCommissionCNY).toLocaleString()} | 保底: {Math.round(totalAnchorGuarantee).toLocaleString()}</div>
                      {anchorSubsidy > 0 && <div className="text-amber-400 text-xs">保底补贴: +{Math.round(anchorSubsidy).toLocaleString()} 元</div>}
                      <div className="text-slate-400 text-xs">人均 {Math.round(anchorFinalPay / anchorCount).toLocaleString()} 元</div>
                    </div>
                  </div>
                </div>
                <div className={"p-2 rounded-lg " + (isGuaranteePeriod && hostSubsidy > 0 ? 'bg-amber-900/40 border border-amber-600' : 'bg-blue-900/30')}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2"><span className="text-blue-400">主持</span><span className="text-slate-400 text-xs">({hostRate}%,营收)</span>{isGuaranteePeriod && <span className="px-1.5 py-0.5 bg-amber-600 text-white text-xs rounded">保底</span>}</div>
                    <div className="text-right"><div className="text-blue-400 font-bold">{Math.round(hostFinalPay).toLocaleString()} 元</div>{isGuaranteePeriod && <div className="text-slate-400 text-xs">分成: {Math.round(hostCommissionCNY).toLocaleString()} | 保底: {Math.round(hostGuaranteeTotal).toLocaleString()}</div>}{hostSubsidy > 0 && <div className="text-amber-400 text-xs">保底补贴: +{Math.round(hostSubsidy).toLocaleString()} 元</div>}</div>
                  </div>
                </div>
                <div className="flex items-center justify-between p-2 bg-green-900/30 rounded-lg">
                  <div className="flex items-center gap-2"><span className="text-green-400">运营</span><span className="text-slate-400 text-xs">({operatorRate}%,营收)</span></div>
                  <div className="text-right"><div className="text-green-400 font-bold">{Math.round(operatorCommissionCNY).toLocaleString()} 元</div></div>
                </div>
                <div className="flex items-center justify-between p-2 bg-pink-900/30 rounded-lg">
                  <div className="flex items-center gap-2"><span className="text-pink-400">HR团队</span><span className="text-slate-400 text-xs">({hrRate}%,营收)</span></div>
                  <div className="text-right"><div className="text-pink-400 font-bold">{Math.round(hrCommission).toLocaleString()} 元</div></div>
                </div>
                <div className="flex items-center justify-between p-2 bg-slate-700/50 rounded-lg border border-slate-600">
                  <span className="text-slate-300">分成合计</span>
                  <span className="text-slate-300 font-bold">{Math.round(totalCommissionsCNY).toLocaleString()} 元</span>
                </div>
              </div>
            </div>
            <div className={"rounded-xl p-6 border-2 " + (companyProfit >= 0 ? 'bg-green-900/30 border-green-600' : 'bg-red-900/30 border-red-600')}>
              <div className="text-center">
                <div className={"text-4xl font-bold " + (companyProfit >= 0 ? 'text-green-400' : 'text-red-400')}>{companyProfit >= 0 ? '+' : ''}{Math.round(companyProfit).toLocaleString()} 元</div>
                <div className={"text-sm " + (companyProfit >= 0 ? 'text-green-300' : 'text-red-300')}>{companyProfit >= 0 ? '公司毛利' : '亏损'}</div>
              </div>
            </div>
            <div className="bg-amber-900/20 border border-amber-700/50 rounded-xl p-3">
              <div className="text-amber-200 text-xs space-y-1">
                <div><span className="font-semibold">计算公式：</span></div>
                <div>• 营业收入 = 月流水(钻) ÷ 100 × 汇率</div>
                <div>• 主播分成 = 流水(钻) × 阶梯% ÷ 100 × 汇率</div>
                <div>• 主持/运营分成 = 营业收入(元) × 阶梯%</div>
                <div>• HR分成 = 营业收入 × {hrRate}%</div>
                <div>• 保底发放 = 保底金额 × (实际时长 / 要求时长)</div>
                <div>• 最终发放 = max(分成, 保底发放)</div>
                <div>• 公司毛利 = 营业收入 - 分成合计 - 固定开支</div>
              </div>
            </div>
            <div className="bg-slate-800/60 backdrop-blur rounded-xl p-4 border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-3 flex items-center gap-2"><Link className="w-5 h-5 text-purple-400" />相关文档</h2>
              <div className="grid grid-cols-2 gap-2">
                <a href="https://feishu.cn/docx/A1ZMdgQSDo02hrxkBLlcsGgansg" target="_blank" rel="noopener noreferrer" className="p-2 bg-slate-700/50 rounded-lg hover:bg-slate-700 transition-colors text-center"><div className="text-white text-sm">分成方案</div></a>
                <a href="https://feishu.cn/docx/IoWAde7NDowpXcxO3N6ck5JRn4e" target="_blank" rel="noopener noreferrer" className="p-2 bg-slate-700/50 rounded-lg hover:bg-slate-700 transition-colors text-center"><div className="text-white text-sm">保本线计算</div></a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
