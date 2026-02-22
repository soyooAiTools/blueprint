import { useState, useEffect, useCallback, createContext, useContext } from 'react';

const ModalContext = createContext(null);

export function ModalProvider({ children }) {
  const [modal, setModal] = useState(null);

  const showAlert = useCallback((message) => {
    return new Promise((resolve) => {
      setModal({ type: 'alert', message, resolve });
    });
  }, []);

  const showConfirm = useCallback((message) => {
    return new Promise((resolve) => {
      setModal({ type: 'confirm', message, resolve });
    });
  }, []);

  const showPrompt = useCallback((message, defaultValue = '') => {
    return new Promise((resolve) => {
      setModal({ type: 'prompt', message, defaultValue, resolve });
    });
  }, []);

  const close = useCallback((result) => {
    if (modal?.resolve) modal.resolve(result);
    setModal(null);
  }, [modal]);

  useEffect(() => {
    if (!modal) return;
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (modal.type === 'alert') close(undefined);
        else if (modal.type === 'confirm') close(false);
        else close(null);
      }
      if (e.key === 'Enter' && modal.type === 'alert') close(undefined);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modal, close]);

  return (
    <ModalContext.Provider value={{ showAlert, showConfirm, showPrompt }}>
      {children}
      {modal && <ModalOverlay modal={modal} onClose={close} />}
    </ModalContext.Provider>
  );
}

export function useModal() {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('useModal must be used within ModalProvider');
  return ctx;
}

function ModalOverlay({ modal, onClose }) {
  const [inputValue, setInputValue] = useState(modal.defaultValue || '');

  return (
    <div className="modal-overlay" onClick={() => {
      if (modal.type === 'alert') onClose(undefined);
      else if (modal.type === 'confirm') onClose(false);
      else onClose(null);
    }}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-message">{modal.message}</div>
        
        {modal.type === 'prompt' && (
          <input
            className="modal-input"
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onClose(inputValue); }}
            autoFocus
          />
        )}

        <div className="modal-actions">
          {modal.type === 'alert' && (
            <button className="modal-btn modal-btn-primary" onClick={() => onClose(undefined)} autoFocus>
              确定
            </button>
          )}
          {modal.type === 'confirm' && (
            <>
              <button className="modal-btn modal-btn-cancel" onClick={() => onClose(false)}>
                取消
              </button>
              <button className="modal-btn modal-btn-primary" onClick={() => onClose(true)} autoFocus>
                确定
              </button>
            </>
          )}
          {modal.type === 'prompt' && (
            <>
              <button className="modal-btn modal-btn-cancel" onClick={() => onClose(null)}>
                取消
              </button>
              <button className="modal-btn modal-btn-primary" onClick={() => onClose(inputValue)}>
                确定
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
