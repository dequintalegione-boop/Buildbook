/* Buildbook Telegram allowlist UI. Local-host connection is implemented once in index.html. */
async function telegramAllowlistEditor(){
 if(!TELEGRAM_UI.connected){toast('Сначала подключите локальный хост.');telegramConnectForm();return}
 let current=[];
 try{
  const response=await localTelegramRequest('/api/telegram/allowlist',{method:'GET'});
  current=Array.isArray(response?.users)?response.users:[];
 }catch(error){toast(error.message||'Не удалось загрузить белый список.');return}
 const entries=Array.isArray(current)?current.map(e=>typeof e==='object'&&e?{id:String(e.id||e.userId||''),comment:String(e.comment||'')}:{id:String(e),comment:''}):[];
 const rows=entries.map((e,idx)=>
  ' <tr data-idx="'+idx+'"><td><input name="id_'+idx+'" value="'+esc(e.id)+'" placeholder="123456789" style="width:100%" disabled></td>'+
  '<td><input name="comment_'+idx+'" value="'+esc(e.comment)+'" placeholder="Комментарий" style="width:100%" disabled></td>'+
  '<td><button type="button" class="btn" data-edit="'+idx+'">Редактировать</button> <button type="button" class="btn" data-rm="'+idx+'">Удалить</button></td></tr>'
 ).join('');
 const body=
  '<p class="mu">Список можно менять в любой момент, пока host запущен.</p>'+
  '<div style="overflow:auto"><table id="tg-allow-table"><thead><tr><th>User ID</th><th>Комментарий</th><th></th></tr></thead><tbody>'+
  (rows||'<tr><td colspan="3" class="mu">Список пуст</td></tr>')+'</tbody></table></div>'+
  '<div class="ac" style="margin-top:8px"><button type="button" class="btn" id="tg-allow-add">+ Добавить</button></div>';
 const form=modal('Белый список',body,async form=>{
  const users=[];
  form.querySelectorAll('#tg-allow-table tbody tr[data-idx]').forEach(tr=>{
   const id=String(tr.querySelector('input[name^="id_"]')?.value||'').trim();
   const comment=String(tr.querySelector('input[name^="comment_"]')?.value||'').trim();
   if(id)users.push({id,comment});
  });
  if(!users.length)return showModalError(form,'Добавьте хотя бы один ID.');
  try{
   await localTelegramRequest('/api/telegram/allowlist',{method:'PUT',body:JSON.stringify({users})});
   TELEGRAM_UI.checked=false;await refreshTelegramStatus(true);
   toast('Белый список обновлён');form.closest('.ov')?.remove();render();
  }catch(error){return showModalError(form,error.message||'Ошибка сохранения')}
  return false;
 },true,'Сохранить');
 let rowSeq=entries.length;
 form.querySelector('#tg-allow-add')?.addEventListener('click',()=>{
  const tb=form.querySelector('#tg-allow-table tbody');
  if(!tb)return;if(tb.querySelector('td[colspan]'))tb.innerHTML='';
  const idx=rowSeq++;
  const tr=document.createElement('tr');tr.dataset.idx=String(idx);
  tr.innerHTML='<td><input name="id_'+idx+'" placeholder="123456789" style="width:100%"></td><td><input name="comment_'+idx+'" placeholder="Комментарий" style="width:100%"></td><td><button type="button" class="btn" data-edit="'+idx+'" data-editing="true">Готово</button> <button type="button" class="btn" data-rm="'+idx+'">Удалить</button></td>';
  tb.appendChild(tr);
 });
 form.addEventListener('click',e=>{
  const edit=e.target.closest('[data-edit]');
  if(edit){e.preventDefault();const tr=edit.closest('tr');if(!tr)return;const fields=tr.querySelectorAll('input');const editing=edit.dataset.editing==='true';fields.forEach(field=>{field.disabled=editing;});edit.dataset.editing=editing?'false':'true';edit.textContent=editing?'Редактировать':'Готово';return}
  const btn=e.target.closest('[data-rm]');if(!btn)return;e.preventDefault();btn.closest('tr')?.remove();
 });
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
  mark.textContent='UI-rev 53';
  document.body.appendChild(mark);
 }catch{}
});
