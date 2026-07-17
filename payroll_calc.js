/* steelcore 薪資計算引擎（純函式・設定驅動） */
(function(root){
  'use strict';
  function buildConfig(rows){
    const m={}; (rows||[]).forEach(r=>{if(!(r.key in m))m[r.key]=r;});
    const meta=(k,d)=>(m[k]&&m[k].meta)?m[k].meta:(d||{});
    const val=(k,d)=>(m[k]&&m[k].value!=null)?Number(m[k].value):d;
    return {
      office:meta('ot_office',{first2:1.34,rest:1.67,monthly_cap_hours:54}),
      field:meta('ot_field',{half_day:.5,full_day:1}),
      labor:{rate:val('labor_ins',.125),...meta('labor_ins',{emp:.2,employer:.7})},
      health:{rate:val('health_ins',.0517),...meta('health_ins',{emp:.3,employer:.6,dependent_cap:3})},
      h2nd:{rate:val('health_2nd',.0211),...meta('health_2nd',{threshold_ratio:4})},
      pension:{rate:val('pension',.06)},
      leaveRate:meta('leave_rate',{'特休':0,'公假':0,'婚假':0,'喪假':0,'病假':.5,'事假':1,'產假':0,'補休':0,'曠職':1,'生理假':.5,'過年':0,'颱風':0}),
      grades:(meta('ins_grades',{grades:[]}).grades)||[]
    };
  }
  const num=v=>{const n=parseFloat(v);return isNaN(n)?0:n;};
  const round=v=>Math.round(v);
  function roundToGrade(amount,grades){if(!grades||!grades.length)return amount;for(let i=0;i<grades.length;i++)if(amount<=grades[i])return grades[i];return grades[grades.length-1];}
  function empTypeFromDept(department){return String(department||'').indexOf('辦公')>=0?'office':'field';}
  function hourlyBase(emp){return emp.pay_type==='monthly'?num(emp.base_salary)/30/8:num(emp.daily_wage)/8;}
  function dailyWage(emp){return emp.pay_type==='monthly'?num(emp.base_salary)/30:num(emp.daily_wage);}
  function overtimePay(emp,att,cfg){
    if(emp.emp_type==='office'){
      const h=hourlyBase(emp),ot=num(att.ot_hours),first2=Math.min(ot,2),rest=Math.max(ot-2,0);
      return h*(first2*cfg.office.first2+rest*cfg.office.rest);
    }
    const d=dailyWage(emp);let pay=0;
    if(num(att.ot_hours)>0)pay+=d*cfg.field.half_day;
    if(num(att.night_hours)>0)pay+=d*cfg.field.half_day;
    return pay;
  }
  function calcPayslip(emp,monthAtt,cfg,period){
    monthAtt=monthAtt||[];
    const worked=monthAtt.filter(a=>num(a.work_hours)>0),workDays=worked.length;
    const workHours=monthAtt.reduce((s,a)=>s+num(a.work_hours),0);
    const base=emp.pay_type==='monthly'?num(emp.base_salary):num(emp.daily_wage)*workDays;
    const otItems=monthAtt.map(a=>({date:a.work_date,pay:overtimePay(emp,a,cfg)}));
    const ot=otItems.reduce((s,x)=>s+x.pay,0);
    const leaveItems=monthAtt.filter(a=>num(a.leave_hours)>0).map(a=>{const rate=cfg.leaveRate[a.leave_type]!=null?cfg.leaveRate[a.leave_type]:1;return{date:a.work_date,type:a.leave_type,hours:num(a.leave_hours),deduct:hourlyBase(emp)*num(a.leave_hours)*rate};});
    const leaveDeduct=emp.pay_type==='monthly'?leaveItems.reduce((s,x)=>s+x.deduct,0):0;
    const gross=base+ot-leaveDeduct;
    const insBase=num(emp.insured_salary)>0?num(emp.insured_salary):roundToGrade(base,cfg.grades);
    let laborEmp=0,healthEmp=0,health2nd=0;const employer={};
    if(emp.insure_via==='company'){
      const depCount=Math.min(num(emp.dependents),cfg.health.dependent_cap||3);
      laborEmp=insBase*cfg.labor.rate*cfg.labor.emp;
      healthEmp=insBase*cfg.health.rate*cfg.health.emp*(1+depCount);
      employer.labor=insBase*cfg.labor.rate*cfg.labor.employer;
      employer.health=insBase*cfg.health.rate*cfg.health.employer;
      employer.pension=insBase*cfg.pension.rate;
    }
    const h2ndThreshold=insBase*(cfg.h2nd.threshold_ratio||4);
    if(ot>h2ndThreshold)health2nd=(ot-h2ndThreshold)*cfg.h2nd.rate;
    const net=gross-laborEmp-healthEmp-health2nd;
    return {period,emp_id:emp.id,work_days:workDays,work_hours:workHours,ot_pay:round(ot),gross:round(gross),labor_ins_emp:round(laborEmp),health_ins_emp:round(healthEmp),health_2nd:round(health2nd),leave_deduct:round(leaveDeduct),net:round(net),employer_cost:{labor:round(employer.labor||0),health:round(employer.health||0),pension:round(employer.pension||0)},breakdown:{base:round(base),insBase,otItems,leaveItems}};
  }
  function monthsBetween(from,to){const a=new Date(from),b=new Date(to);let m=(b.getFullYear()-a.getFullYear())*12+(b.getMonth()-a.getMonth());if(b.getDate()<a.getDate())m-=1;return Math.max(m,0);}
  function annualLeaveDays(hireDate,asOf){const m=monthsBetween(hireDate,asOf);if(m<6)return 0;if(m<12)return 3;const y=Math.floor(m/12);if(y===1)return 7;if(y===2)return 10;if(y<5)return 14;if(y<10)return 15;return Math.min(15+(y-9),30);}
  function unusedPayout(days,monthlyTotal){return round(days*(monthlyTotal/30));}
  function annualPeriod(hireDate,asOf){const h=new Date(hireDate),t=new Date(asOf);let anniv=new Date(h.getFullYear()+(t.getFullYear()-h.getFullYear()),h.getMonth(),h.getDate());if(anniv.getTime()>t.getTime())anniv=new Date(anniv.getFullYear()-1,anniv.getMonth(),anniv.getDate());const end=new Date(anniv.getFullYear()+1,anniv.getMonth(),anniv.getDate());const iso=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');return{start:iso(anniv),end:iso(end)};}
  function suggestInsuredGrade(avgMonthlyWage,grades){return roundToGrade(num(avgMonthlyWage),grades);}
  const api={buildConfig,empTypeFromDept,roundToGrade,hourlyBase,dailyWage,overtimePay,calcPayslip,suggestInsuredGrade,monthsBetween,annualLeaveDays,annualPeriod,unusedPayout};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Payroll=api;
})(typeof window!=='undefined'?window:globalThis);
