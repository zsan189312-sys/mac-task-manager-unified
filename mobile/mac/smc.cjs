'use strict';
const {execFile}=require('node:child_process');
const path=require('node:path'),os=require('node:os');
const cpuKeys=new Set(['Te05','Te0S','Te09','Te0H','Tp01','Tp05','Tp09','Tp0D','Tp0V','Tp0Y','Tp0b','Tp0e']);
const gpuKeys=new Set(['Tg0G','Tg0H','Tg0K','Tg0L','Tg0d','Tg0e','Tg0j','Tg0k']);
function decodeSMC(raw){
    const filter=(items,keys)=>Array.isArray(items)?items.filter(s=>s&&keys.has(s.key)&&typeof s.celsius==='number'&&Number.isFinite(s.celsius)&&s.celsius>=10&&s.celsius<=150).map(s=>({key:s.key,celsius:s.celsius})):[];
    const cpuSensors=raw?.available&&raw.source==='AppleSMC'?filter(raw.cpuSensors,cpuKeys):[];
    const gpuSensors=raw?.available&&raw.source==='AppleSMC'?filter(raw.gpuSensors,gpuKeys):[];
    return {source:'AppleSMC',aggregation:'max',cpu:cpuSensors.length?Math.max(...cpuSensors.map(s=>s.celsius)):null,gpu:gpuSensors.length?Math.max(...gpuSensors.map(s=>s.celsius)):null,cpuSensors,gpuSensors,reason:cpuSensors.length?'':'SMC 温度暂不可读，请检查 Mac 采集端'};
}
function readTemperatures(chip){
    if(chip!=='Apple M4')return Promise.resolve({...decodeSMC(null),reason:'此机型尚未验证 SMC 温度映射'});
    const binary=path.join(os.homedir(),'Library/Application Support/TMU-Mobile/bin/smc-temps');
    return new Promise(resolve=>execFile(binary,[],{timeout:3000,maxBuffer:16384},(error,stdout)=>{
        try{resolve(error?{...decodeSMC(null),reason:'温度助手不可用，请重新启动 Mac 采集端'}:decodeSMC(JSON.parse(stdout)));}
        catch(_){resolve({...decodeSMC(null),reason:'SMC 温度响应不可用'});}
    }));
}
module.exports={readTemperatures,decodeSMC};
