/* Buildbook Telegram allowlist UI. Local-host connection is implemented once in index.html. */
async function telegramAllowlistEditor(){
 if(!TELEGRAM_UI.connected){toast('Сначала подключите локальный хост.');telegramConnectForm();return}
 const dashboard=document.querySelector('.tg-dashboard');
 if(!dashboard)return;
 const existing=document.getElementById('tg-allowlist-panel');
 if(existing){existing.scrollIntoView({behavior:'smooth',block:'center'});return}
 let current=[];
 try{
  const response=await localTelegramRequest('/api/telegram/allowlist',{method:'GET'});
  current=Array.isArray(response?.users)?response.users:[];
 }catch(error){toast(error.message||'Не удалось загрузить белый список.');return}
 const entries=current.map(item=>({id:String(item?.id||item?.userId||''),comment:String(item?.comment||''),active:item?.active!==false,addedAt:typeof item?.addedAt==='string'?item.addedAt:''}));
 const renderRows=users=>users.map((item,index)=>
  '<tr data-idx="'+index+'" data-added-at="'+esc(item.addedAt||'')+'"><td><input data-field="id" type="text" inputmode="numeric" maxlength="16" value="'+esc(item.id)+'" placeholder="123456789" aria-label="ID пользователя" style="width:100%" disabled></td>'+
  '<td><input data-field="comment" type="text" maxlength="80" value="'+esc(item.comment)+'" placeholder="Комментарий" aria-label="Комментарий" style="width:100%" disabled></td>'+
  '<td><select data-field="active" aria-label="Состояние пользователя"><option value="true" '+(item.active?'selected':'')+'>Активен</option><option value="false" '+(!item.active?'selected':'')+'>Отключён</option></select></td>'+
  '<td>'+(item.addedAt?esc(stamp(item.addedAt)):'—')+'</td>'+
  '<td><div class="ac"><button type="button" class="btn" data-edit="'+index+'">Редактировать</button><button type="button" class="btn" data-rm="'+index+'">Удалить</button></div></td></tr>'
 ).join('');
 const panelHtml='<section id="tg-allowlist-panel"><div class="hd"><h2>Белый список пользователей</h2><div class="ac"><span class="mu" data-tg-allow-count>Пользователей: '+entries.length+' · активных: '+entries.filter(item=>item.active!==false).length+'</span><button type="button" class="btn" data-tg-allow-close>Скрыть</button></div></div>'+
  '<p class="mu">Активные пользователи могут отправлять команды боту. Отключённые сохраняются в списке, но их сообщения не обрабатываются. Изменения применяются сразу, перезапуск Telegram не требуется.</p>'+
  '<div style="overflow:auto"><table id="tg-allow-table"><thead><tr><th>ID пользователя</th><th>Комментарий</th><th>Состояние</th><th>Добавлен</th><th>Действия</th></tr></thead><tbody>'+
  (renderRows(entries)||'<tr data-empty="true"><td colspan="5" class="mu">Список пуст. Добавьте первого пользователя.</td></tr>')+
  '</tbody></table></div><div class="ac" style="margin-top:10px"><button type="button" class="btn" data-tg-allow-add>+ Добавить пользователя</button><button type="button" class="btn p" data-tg-allow-save>Сохранить изменения</button></div></section>';
 dashboard.insertAdjacentHTML('beforeend',panelHtml);
 const panel=document.getElementById('tg-allowlist-panel');
 if(!panel)return;
 let rowSeq=entries.length;
 panel.addEventListener('click',async event=>{
  const close=event.target.closest('[data-tg-allow-close]');
  if(close){panel.remove();return}
  const add=event.target.closest('[data-tg-allow-add]');
  if(add){
   const body=panel.querySelector('#tg-allow-table tbody');
   if(!body)return;
   body.querySelector('[data-empty]')?.remove();
   const index=rowSeq++;
   const row=document.createElement('tr');
   row.dataset.idx=String(index);
   row.innerHTML='<td><input data-field="id" type="text" inputmode="numeric" maxlength="16" placeholder="123456789" aria-label="ID пользователя" style="width:100%"></td>'+
    '<td><input data-field="comment" type="text" maxlength="80" placeholder="Комментарий" aria-label="Комментарий" style="width:100%"></td>'+
    '<td><select data-field="active" aria-label="Состояние пользователя"><option value="true" selected>Активен</option><option value="false">Отключён</option></select></td><td>—</td>'+
    '<td><div class="ac"><button type="button" class="btn" data-edit="'+index+'" data-editing="true">Готово</button><button type="button" class="btn" data-rm="'+index+'">Удалить</button></div></td>';
   body.appendChild(row);
   row.querySelector('[data-field="id"]')?.focus();
   return;
  }
  const edit=event.target.closest('[data-edit]');
  if(edit){
   const row=edit.closest('tr');
   if(!row)return;
   const editing=edit.dataset.editing==='true';
   row.querySelectorAll('input').forEach(input=>{input.disabled=editing});
   edit.dataset.editing=editing?'false':'true';
   edit.textContent=editing?'Редактировать':'Готово';
   return;
  }
  const remove=event.target.closest('[data-rm]');
  if(remove){
   const row=remove.closest('tr');
   const id=String(row?.querySelector('[data-field="id"]')?.value||'').trim();
   if(!confirm('Удалить пользователя '+(id||'из списка')+' из белого списка?'))return;
   row?.remove();
   const body=panel.querySelector('#tg-allow-table tbody');
   if(body&&!body.querySelector('tr[data-idx]'))body.innerHTML='<tr data-empty="true"><td colspan="5" class="mu">Список пуст. Добавьте пользователя.</td></tr>';
   const count=panel.querySelector('[data-tg-allow-count]');
   if(count)count.textContent='Пользователей: '+(body?.querySelectorAll('tr[data-idx]').length||0);
   return;
  }
  const save=event.target.closest('[data-tg-allow-save]');
  if(!save)return;
  const users=[];
  panel.querySelectorAll('#tg-allow-table tbody tr[data-idx]').forEach(row=>{
   const id=String(row.querySelector('[data-field="id"]')?.value||'').trim();
   const comment=String(row.querySelector('[data-field="comment"]')?.value||'').trim();
   const active=row.querySelector('[data-field="active"]')?.value!=='false';
   const addedAt=String(row.dataset.addedAt||'');
   if(id)users.push({id,comment,active,...(addedAt?{addedAt}:{})});
  });
  if(!users.length){toast('Добавьте хотя бы один числовой Telegram user ID.');return}
  if(!users.some(user=>user.active)){toast('Оставьте хотя бы одного активного пользователя.');return}
  save.disabled=true;save.textContent='Сохраняем…';
  try{
   const result=await localTelegramRequest('/api/telegram/allowlist',{method:'PUT',body:JSON.stringify({users})});
   const savedUsers=Array.isArray(result?.users)?result.users:users;
   const body=panel.querySelector('#tg-allow-table tbody');
   if(body)body.innerHTML=renderRows(savedUsers)||'<tr data-empty="true"><td colspan="5" class="mu">Список пуст.</td></tr>';
   const count=panel.querySelector('[data-tg-allow-count]');
   if(count)count.textContent='Пользователей: '+savedUsers.length+' · активных: '+savedUsers.filter(user=>user.active!==false).length;
   toast('Белый список обновлён. Изменения применены без перезапуска бота.');
   await refreshTelegramStatus(true);
  }catch(error){
   toast(error.message||'Не удалось сохранить белый список.');
  }finally{
   if(save.isConnected){save.disabled=false;save.textContent='Сохранить изменения'}
  }
 });
 panel.scrollIntoView({behavior:'smooth',block:'center'});
}

document.addEventListener('click',function(e){
 const btn=e.target&&e.target.closest&&e.target.closest('[data-a="tgallowlist"]');
 if(!btn)return;
 e.preventDefault();e.stopPropagation();
 if(typeof telegramAllowlistEditor==='function')telegramAllowlistEditor();
},true);


function telegramActivityUrl(limit,offset,filters){
 const params=new URLSearchParams({
  limit:String(limit),offset:String(offset),
  search:String(filters?.search||''),
  status:String(filters?.status||'all'),
  action:String(filters?.action||'all')
 });
 return '/api/activity?'+params.toString();
}
async function loadMoreTelegramActivity(){
 if(TELEGRAM_UI.activityLoading||!TELEGRAM_UI.activityHasMore)return;
 TELEGRAM_UI.activityLoading=true;
 const button=document.querySelector('[data-tg-activity-more]');
 if(button){button.disabled=true;button.textContent='Загружаем…'}
 try{
  const result=await localTelegramRequest(telegramActivityUrl(100,TELEGRAM_UI.activityOffset,TELEGRAM_UI.activityFilters));
  const events=Array.isArray(result?.events)?result.events:[];
  TELEGRAM_UI.activity=TELEGRAM_UI.activity.concat(events);
  TELEGRAM_UI.activityOffset=Number(result?.offset||0)+events.length;
  TELEGRAM_UI.activityHasMore=result?.hasMore===true;
 }catch(error){toast(error.message||'Не удалось загрузить следующую страницу журнала.')}
 finally{TELEGRAM_UI.activityLoading=false;render()}
}

async function exportTelegramActivity(){
 try{
  const all=[];
  let offset=0,hasMore=true;
  while(hasMore){
   const result=await localTelegramRequest('/api/activity?limit=499&offset='+encodeURIComponent(String(offset)));
   const page=Array.isArray(result?.events)?result.events:[];
   all.push(...page);
   offset+=page.length;
   hasMore=result?.hasMore===true;
   if(!page.length&&hasMore)throw new Error('Журнал вернул пустую страницу при наличии следующих событий.');
  }
  const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),events:all},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;
  link.download='buildbook-telegram-activity-'+new Date().toISOString().slice(0,10)+'.json';
  document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
  toast('Экспортировано событий: '+all.length);
 }catch(error){toast(error.message||'Не удалось экспортировать журнал.')}
}

async function filterTelegramActivity(reset=true){
 if(TELEGRAM_UI.activityLoading)return;
 const filters={
  search:String(document.querySelector('[data-tg-activity-search]')?.value||'').trim(),
  status:String(document.querySelector('[data-tg-activity-status]')?.value||'all'),
  action:String(document.querySelector('[data-tg-activity-type]')?.value||'all')
 };
 TELEGRAM_UI.activityFilters=filters;
 TELEGRAM_UI.activityLoading=true;
 try{
  const offset=reset?0:TELEGRAM_UI.activityOffset;
  const result=await localTelegramRequest(telegramActivityUrl(100,offset,filters));
  const events=Array.isArray(result?.events)?result.events:[];
  TELEGRAM_UI.activity=reset?events:TELEGRAM_UI.activity.concat(events);
  TELEGRAM_UI.activityOffset=Number(result?.offset||0)+events.length;
  TELEGRAM_UI.activityHasMore=result?.hasMore===true;
 }catch(error){toast(error.message||'Не удалось применить фильтры журнала.')}
 finally{TELEGRAM_UI.activityLoading=false;render()}
}

document.addEventListener('click',function(event){
 const more=event.target&&event.target.closest&&event.target.closest('[data-a="tgactivitymore"]');
 if(more){event.preventDefault();loadMoreTelegramActivity();return}
 const searchButton=event.target&&event.target.closest&&event.target.closest('[data-tg-activity-search-all]');
 if(searchButton){event.preventDefault();filterTelegramActivity(true);return}
 const clearButton=event.target&&event.target.closest&&event.target.closest('[data-tg-activity-clear]');
 if(clearButton){
  event.preventDefault();
  const search=document.querySelector('[data-tg-activity-search]');
  const status=document.querySelector('[data-tg-activity-status]');
  const type=document.querySelector('[data-tg-activity-type]');
  if(search)search.value='';
  if(status)status.value='all';
  if(type)type.value='all';
  filterTelegramActivity(true);return;
 }
 const exportButton=event.target&&event.target.closest&&event.target.closest('[data-tg-activity-export]');
 if(exportButton){event.preventDefault();exportTelegramActivity()}
},true);
document.addEventListener('input',function(event){
 if(event.target&&event.target.matches&&event.target.matches('[data-tg-activity-search]'))filterTelegramActivity();
},true);
document.addEventListener('change',function(event){
 if(event.target&&event.target.matches&&event.target.matches('[data-tg-activity-status],[data-tg-activity-type]'))filterTelegramActivity(true);
},true);
document.addEventListener('keydown',function(event){
 if(event.key==='Enter'&&event.target&&event.target.matches&&event.target.matches('[data-tg-activity-search]')){
  event.preventDefault();filterTelegramActivity(true);
 }
},true);
