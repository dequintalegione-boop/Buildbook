(function(global){
'use strict';

const PROFILE_KEYS=Object.freeze(['s','l','p','r']);

function create(databaseName){
 const name=String(databaseName||'buildbook').trim();
 if(!name)throw new Error('Не задано имя локальной базы данных.');
 let connectionPromise=null;

 function open(){
  if(connectionPromise)return connectionPromise;
  let promise;
  promise=new Promise((resolve,reject)=>{
   let request,settled=false;
   const fail=error=>{
    if(settled)return;
    settled=true;
    reject(error);
   };
   try{
    if(!global.indexedDB)throw new Error('Браузер не поддерживает локальную базу данных IndexedDB.');
    request=global.indexedDB.open(name,1);
   }catch(error){fail(error);return}
   request.onupgradeneeded=()=>{
    const database=request.result;
    if(!database.objectStoreNames.contains('kv'))database.createObjectStore('kv');
   };
   request.onsuccess=()=>{
    const database=request.result;
    database.onversionchange=()=>{
     database.close();
     if(connectionPromise===promise)connectionPromise=null;
    };
    if(settled){database.close();return}
    settled=true;
    resolve(database);
   };
   request.onerror=()=>fail(request.error||new Error('Не удалось открыть локальную базу данных.'));
   request.onblocked=()=>fail(new Error('База данных занята другой вкладкой. Закройте другие вкладки Buildbook и повторите запуск.'));
  });
  connectionPromise=promise;
  promise.catch(()=>{if(connectionPromise===promise)connectionPromise=null});
  return promise;
 }

 function read(key){
  if(!PROFILE_KEYS.includes(key))return Promise.reject(new Error('Недопустимый ключ локального хранилища.'));
  return open().then(database=>new Promise((resolve,reject)=>{
   let transaction,value,settled=false;
   const fail=error=>{
    if(settled)return;
    settled=true;
    reject(error);
   };
   try{
    transaction=database.transaction('kv','readonly');
    const request=transaction.objectStore('kv').get(key);
    request.onsuccess=()=>{value=request.result};
    request.onerror=()=>fail(request.error||new Error('Не удалось прочитать данные локальной базы.'));
   }catch(error){fail(error);return}
   transaction.oncomplete=()=>{
    if(settled)return;
    settled=true;
    resolve(value);
   };
   transaction.onerror=()=>fail(transaction.error||new Error('Ошибка чтения локальной базы.'));
   transaction.onabort=()=>fail(transaction.error||new Error('Чтение локальной базы было отменено.'));
  }));
 }

 function readProfile(){
  return open().then(database=>new Promise((resolve,reject)=>{
   let transaction,settled=false;
   const values={};
   const fail=error=>{
    if(settled)return;
    settled=true;
    reject(error);
   };
   try{
    transaction=database.transaction('kv','readonly');
    const store=transaction.objectStore('kv');
    PROFILE_KEYS.forEach(key=>{
     const request=store.get(key);
     request.onsuccess=()=>{values[key]=request.result};
     request.onerror=()=>fail(request.error||new Error('Не удалось прочитать данные локальной базы.'));
    });
   }catch(error){fail(error);return}
   transaction.oncomplete=()=>{
    if(settled)return;
    settled=true;
    resolve({state:values.s,logs:values.l,photos:values.p,revision:Number.isSafeInteger(values.r)&&values.r>=0?values.r:0});
   };
   transaction.onerror=()=>fail(transaction.error||new Error('Ошибка чтения локальной базы.'));
   transaction.onabort=()=>fail(transaction.error||new Error('Чтение локальной базы было отменено.'));
  }));
 }

 function writeProfile(state,logs,photos,expectedRevision){
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)return Promise.reject(new Error('Не задана корректная версия профиля для сохранения.'));
  return open().then(database=>new Promise((resolve,reject)=>{
   let transaction,settled=false,nextRevision=0;
   const fail=error=>{
    if(settled)return;
    settled=true;
    reject(error);
   };
   try{
    transaction=database.transaction('kv','readwrite');
    transaction.oncomplete=()=>{
     if(settled)return;
     settled=true;
     resolve(nextRevision);
    };
    transaction.onerror=()=>fail(transaction.error||new Error('Не удалось сохранить данные в локальную базу.'));
    transaction.onabort=()=>fail(transaction.error||new Error('Запись в локальную базу была отменена.'));
    const store=transaction.objectStore('kv');
    const revisionRequest=store.get('r');
    revisionRequest.onsuccess=()=>{
     const currentRevision=Number.isSafeInteger(revisionRequest.result)&&revisionRequest.result>=0?revisionRequest.result:0;
     if(currentRevision!==expectedRevision){
      const conflict=new Error('Профиль уже изменён в другой вкладке. Эта вкладка не будет перезаписывать более свежие данные.');
      conflict.name='BuildbookStorageConflictError';
      conflict.code='BUILD_BOOK_STORAGE_CONFLICT';
      conflict.expectedRevision=expectedRevision;
      conflict.currentRevision=currentRevision;
      fail(conflict);
      try{transaction.abort()}catch(_){}
      return;
     }
     nextRevision=currentRevision+1;
     try{
      store.put(state,'s');
      store.put(logs,'l');
      store.put(photos,'p');
      store.put(nextRevision,'r');
     }catch(error){
      fail(error);
      try{transaction.abort()}catch(_){}
     }
    };
    revisionRequest.onerror=()=>fail(revisionRequest.error||new Error('Не удалось проверить версию профиля перед сохранением.'));
   }catch(error){
    if(transaction){try{transaction.abort()}catch(_){}}
    fail(error);
   }
  }));
 }

 function close(){
  if(!connectionPromise)return;
  const pending=connectionPromise;
  connectionPromise=null;
  pending.then(database=>database.close()).catch(()=>{});
 }

 async function deleteDatabase(){
  if(connectionPromise){
   try{(await connectionPromise).close()}catch(_){}
   connectionPromise=null;
  }
  return new Promise((resolve,reject)=>{
   let request;
   try{request=global.indexedDB.deleteDatabase(name)}
   catch(error){reject(error);return}
   request.onsuccess=()=>resolve(true);
   request.onerror=()=>reject(request.error||new Error('Не удалось удалить локальную базу данных.'));
   request.onblocked=()=>reject(new Error('Удаление базы заблокировано другой вкладкой. Закройте остальные вкладки Buildbook и повторите попытку.'));
  });
 }

 return Object.freeze({name,open,read,readProfile,writeProfile,close,deleteDatabase});
}

if(!Object.prototype.hasOwnProperty.call(global,'BuildbookRepository')){
 Object.defineProperty(global,'BuildbookRepository',{
  configurable:false,enumerable:false,writable:false,
  value:Object.freeze({create})
 });
}
})(window);
