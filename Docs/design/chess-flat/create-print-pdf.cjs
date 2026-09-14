const {chromium}=require('playwright');
const fs=require('fs');
const path=require('path');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const page=await browser.newPage({viewport:{width:1480,height:1040},colorScheme:'light'});
 await page.setContent(fs.readFileSync(path.join(__dirname,'print-sample.html'),'utf8'));
 fs.mkdirSync('/Users/max/zhbi-tool/output/pdf',{recursive:true});
 await page.pdf({path:'/Users/max/zhbi-tool/output/pdf/chess-flat-walkthrough-sample.pdf',format:'A4',landscape:false,printBackground:true,preferCSSPageSize:true,margin:{top:'6mm',bottom:'6mm',left:'6mm',right:'6mm'}});
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
