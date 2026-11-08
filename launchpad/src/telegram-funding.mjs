import {randomUUID} from 'node:crypto';
import {FundingService,equalFundingPercentages} from './funding.mjs';
export class TelegramFunding {
  constructor(bot,service){this.bot=bot;this.service=service||new FundingService(bot.accounts,bot.runtimeManager,bot.robinhood?.runtimes);}
  button(ctx,text,op,args={}){return this.bot.button(ctx,text,op,args,120000);}
  tokens(chain){return chain==='robinhood'?['ETH','USDG']:['SOL','USDC'];}
  async menu(ctx){ctx.prompt=null;ctx.fundingDraft=null;ctx.navigation++;const view=await this.service.overview(ctx.account.id,ctx.chain),rows=[];
    if(view.configured)rows.push([this.button(ctx,'Fund wallets','fundingNew')]);
    for(const o of view.orders.filter(o=>o.input.chain===ctx.chain).slice(0,5))rows.push([this.button(ctx,`${o.input.totalAmount} ${o.input.send} · ${o.state}`.slice(0,60),'fundingOrder',{id:o.id})]);
    if(/^https:\/\//.test(this.bot.publicUrl))rows.push([{text:'Open Funding on web',url:`${this.bot.publicUrl}/funding?chain=${ctx.chain}`}]);rows.push([this.bot.homeButton(ctx)]);
    this.bot.say(ctx,`Funding · ${ctx.chain==='robinhood'?'Robinhood':'Solana'}\n${this.tokens(ctx.chain).join(' or ')}\n\n${view.configured?'Choose wallets and amounts. Review the conversion, then make one deposit to fund them.':'The Launchpad owner needs to add the Husher key in Connections.'}\n\nNo wallet funds move when you request a quote.`,rows);
  }
  draft(ctx){const d=ctx.fundingDraft;if(!d||d.accountId!==ctx.account.id||d.chain!==ctx.chain||d.expires<this.bot.now())throw Error('Funding draft expired. Open Funding again.');return d;}
  select(ctx,page=0){const d=this.draft(ctx);ctx.prompt=null;d.stage='wallets';ctx.navigation++;page=Math.max(0,Math.min(Number(page)||0,Math.max(0,Math.ceil(d.wallets.length/8)-1)));const rows=d.wallets.slice(page*8,page*8+8).map(w=>[this.button(ctx,`${d.selected.includes(w.address)?'✓ ':''}${w.label.slice(0,25)} · ${w.address.slice(0,5)}`,'fundingToggle',{address:w.address,page})]);
    rows.push([this.button(ctx,'Select all','fundingAll',{page})]);
    rows.push([this.button(ctx,'Equal split','fundingInput',{mode:'percent'}),this.button(ctx,'Amount each','fundingInput',{mode:'amount'})],[this.button(ctx,'Random amounts','fundingInput',{mode:'random'})]);
    if(page>0)rows.push([this.button(ctx,'‹ Previous','fundingPage',{page:page-1})]);if((page+1)*8<d.wallets.length)rows.push([this.button(ctx,'More wallets ›','fundingPage',{page:page+1})]);rows.push([this.button(ctx,'‹ Funding','funding')]);this.bot.say(ctx,`Choose destination wallets\n${d.selected.length} selected\n\nThen choose how to split your funding.`,rows);
  }
  chooseAsset(ctx,stage){const d=this.draft(ctx);ctx.prompt=null;ctx.navigation++;d.stage=stage;
    this.bot.say(ctx,`${stage==='send'?'What will you deposit?':'What should your wallets receive?'}\n${ctx.chain==='robinhood'?'Robinhood Chain':'Solana'} only`,[this.tokens(ctx.chain).map(token=>this.button(ctx,token,'fundingAsset',{stage,token})),[this.button(ctx,'‹ Wallets','fundingPage')]]);
  }
  askAmount(ctx){const d=this.draft(ctx);d.stage='amount';ctx.navigation++;ctx.prompt={kind:'funding',id:d.id,revision:ctx.revision,expires:d.expires};
    const question=d.mode==='random'?`Send a minimum and maximum ${d.send} amount per wallet.\nExample: 0.01 0.05\n\nThe random amounts are fixed in your review.`:d.mode==='amount'?`How much ${d.send} should be sent for each wallet?\nExample: 0.02\n\nFor different amounts, send ${d.selected.length} comma-separated values in the selected wallet order.`:`How much ${d.send} will you send in total?\nExample: 0.5\n\nThe total is split equally across ${d.selected.length} wallets.`;
    this.bot.say(ctx,`${d.send} → ${d.receive} · ${d.chain==='robinhood'?'Robinhood':'Solana'}\n\n${question}\n\nReceived amounts are estimated after conversion and fees.`,[[this.button(ctx,'‹ Assets','fundingInput',{mode:d.mode})]]);
  }
  async review(ctx,o,page=0){ctx.prompt=null;ctx.navigation++;page=Math.max(0,Math.min(Number(page)||0,Math.ceil(o.quotes.length/20)-1));const rows=[];if(o.state==='quoted')rows.push([this.button(ctx,'Confirm · create deposit order','fundingConfirm',{id:o.id,reviewHash:o.reviewHash})]);else rows.push([this.button(ctx,'Refresh this order','fundingRefresh',{id:o.id})]);if(page>0)rows.push([this.button(ctx,'‹ Previous wallets','fundingOrder',{id:o.id,page:page-1})]);if((page+1)*20<o.quotes.length)rows.push([this.button(ctx,'More wallets ›','fundingOrder',{id:o.id,page:page+1})]);rows.push([this.button(ctx,'‹ Funding','funding')]);
    const details=o.deposit?`\n\nDeposit ${o.deposit.amount} ${o.deposit.token} on ${o.deposit.network} ONLY:\n${o.deposit.address}${o.deposit.tag?`\nRequired memo / tag: ${o.deposit.tag}`:''}\nService fee: ${o.deposit.feeAmount}; network fee: ${o.deposit.networkFee}.`:'';
    this.bot.say(ctx,`Funding · ${o.state}\nSend ${o.input.totalAmount} ${o.input.send} on ${o.input.sendNetwork}. Receive ${o.input.receive} on ${o.input.receiveNetwork}.\n${details}\n\nWallets ${page*20+1}–${Math.min(o.quotes.length,(page+1)*20)} of ${o.quotes.length}\n${o.quotes.slice(page*20,page*20+20).map(q=>`${q.address.slice(0,6)}…${q.address.slice(-4)} · ${q.sendAmount?Number(q.sendAmount).toPrecision(8)+' '+o.input.send+' sent':q.percent+'%'} · ~${Number(q.receiveAmount).toPrecision(8)} ${o.input.receive}`).join('\n')}${o.error?'\n\n'+o.error:''}\n\nHusher processes your deposit. Creating an order does not send funds.`,rows);
  }
  async action(ctx,op,args={}){if(!ctx.account)throw Error('Sign in to your Launchpad account.');
    if(op==='funding')return this.menu(ctx);
    if(op==='fundingNew'){const v=await this.service.overview(ctx.account.id,ctx.chain);if(!v.configured)throw Error('The owner must configure Husher first.');const wallets=v.wallets.filter(w=>w.chain===ctx.chain);if(!wallets.length)throw Error('Import or generate destination wallets first.');ctx.fundingDraft={id:randomUUID(),accountId:ctx.account.id,chain:ctx.chain,wallets,selected:[],expires:this.bot.now()+10*60000};return this.select(ctx);}
    if(['fundingPage','fundingToggle','fundingAll'].includes(op)){const d=this.draft(ctx);if(op==='fundingToggle'){if(!d.wallets.some(w=>w.address===args.address))throw Error('Unknown wallet.');d.selected=d.selected.includes(args.address)?d.selected.filter(x=>x!==args.address):[...d.selected,args.address];}if(op==='fundingAll')d.selected=d.wallets.slice(0,100).map(w=>w.address);return this.select(ctx,args.page);}
    if(op==='fundingInput'){const d=this.draft(ctx);if(!d.selected.length||d.selected.length>100)throw Error('Select 1–100 wallets.');if(!['percent','amount','random'].includes(args.mode||'percent'))throw Error('Choose a funding method.');d.mode=args.mode||'percent';return this.chooseAsset(ctx,'send');}
    if(op==='fundingAsset'){const d=this.draft(ctx);if(args.stage!==d.stage||!['send','receive'].includes(args.stage)||!this.tokens(d.chain).includes(args.token))throw Error('Choose one of the displayed assets.');d[args.stage]=args.token;return args.stage==='send'?this.chooseAsset(ctx,'receive'):this.askAmount(ctx);}
    if(op==='fundingConfirm')return this.review(ctx,await this.service.create(ctx.account.id,args.id,args.reviewHash));
    if(op==='fundingRefresh')return this.review(ctx,await this.service.refresh(ctx.account.id,args.id));
    if(op==='fundingOrder'){const v=await this.service.overview(ctx.account.id,ctx.chain),o=v.orders.find(o=>o.id===args.id&&o.input.chain===ctx.chain);if(!o)throw Error('Funding order not found.');return this.review(ctx,o,args.page);}
    throw Error('Open Funding again.');
  }
  async message(ctx,message){const p=ctx.prompt,d=this.draft(ctx);await this.bot.deleteInput(ctx,message,true);if(!p||p.id!==d.id||p.expires<this.bot.now()||p.revision!==ctx.revision||d.stage!=='amount'||message.document)throw Error('Funding prompt expired. Open Funding again.');
    const values=String(message.text||'').trim().split(/[\s,]+/),mode=d.mode;
    if(mode==='percent'&&values.length!==1||mode==='random'&&values.length!==2||mode==='amount'&&values.length!==1&&values.length!==d.selected.length)throw Error(mode==='random'?'Enter a minimum and maximum amount.':'Enter one amount, or the requested list of per-wallet amounts.');
    const network=await this.service.destination(d.chain),percents=equalFundingPercentages(d.selected.length);
    const order=await this.service.quote(ctx.account.id,{chain:d.chain,send:d.send,receive:d.receive,sendNetwork:network,allocationMode:mode,totalAmount:values[0],randomMin:values[0],randomMax:values[1],recipients:d.selected.map((address,i)=>({address,percent:percents[i],amount:values.length===1?values[0]:values[i],provider:'husher'}))});return this.review(ctx,order);
  }
}
