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
 const entries=current.map(item=>({id:String(item?.id||item?.userId||''),comment:String(item?.comment||'')}));
 const renderRows=users=>users.map((item,index)=>
  '<tr data-idx="'+index+'"><td><input data-field="id" type="text" inputmode="numeric" maxlength="16" value="'+esc(item.id)+'" placeholder="123456789" aria-label="ID пользователя" style="width:100%" disabled></td>'+
  '<td><input data-field="comment" type="text" maxlength="80" value="'+esc(item.comment)+'" placeholder="Комментарий" aria-label="Комментарий" style="width:100%" disabled></td>'+
  '<td><div class="ac"><button type="button" class="btn" data-edit="'+index+'">Редактировать</button><button type="button" class="btn" data-rm="'+index+'">Удалить</button></div></td></tr>'
 ).join('');
 const panelHtml='<section id="tg-allowlist-panel"><div class="hd"><h2>Белый список пользователей</h2><div class="ac"><span class="mu" data-tg-allow-count>Пользователей: '+entries.length+'</span><button type="button" class="btn" data-tg-allow-close>Скрыть</button></div></div>'+
  '<p class="mu">Разрешённые пользователи могут отправлять команды боту. Комментарий нужен только для удобства. Изменения применяются сразу, перезапуск Telegram не требуется.</p>'+
  '<div style="overflow:auto"><table id="tg-allow-table"><thead><tr><th>ID пользователя</th><th>Комментарий</th><th>Действия</th></tr></thead><tbody>'+
  (renderRows(entries)||'<tr data-empty="true"><td colspan="3" class="mu">Список пуст. Добавьте первого пользователя.</td></tr>')+
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
   remove.closest('tr')?.remove();
   const body=panel.querySelector('#tg-allow-table tbody');
   if(body&&!body.querySelector('tr[data-idx]'))body.innerHTML='<tr data-empty="true"><td colspan="3" class="mu">Список пуст. Добавьте пользователя.</td></tr>';
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
   if(id)users.push({id,comment});
  });
  if(!users.length){toast('Добавьте хотя бы один числовой Telegram user ID.');return}
  save.disabled=true;save.textContent='Сохраняем…';
  try{
   const result=await localTelegramRequest('/api/telegram/allowlist',{method:'PUT',body:JSON.stringify({users})});
   const savedUsers=Array.isArray(result?.users)?result.users:users;
   const body=panel.querySelector('#tg-allow-table tbody');
   if(body)body.innerHTML=renderRows(savedUsers)||'<tr data-empty="true"><td colspan="3" class="mu">Список пуст.</td></tr>';
   const count=panel.querySelector('[data-tg-allow-count]');
   if(count)count.textContent='Пользователей: '+savedUsers.length;
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

document.addEventListener('DOMContentLoaded',function(){
 try{
  const mark=document.createElement('div');
  mark.id='bb-ui-rev';
  mark.style.cssText='position:fixed;right:8px;bottom:8px;z-index:9999;font:12px monospace;opacity:.55;pointer-events:none';
  mark.textContent='UI-rev 54';
  document.body.appendChild(mark);
 }catch{}
});
