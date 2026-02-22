import { createContext, useContext, useState, useCallback } from 'react';

const ModalContext = createContext(null);

export function ModalProvider({ children }) {
  const [modal, setModal] = useState(null);

  const showModal = useCallback((type, message, defaultValue) => {
    return new Promise((resolve) => {
      setModal({ type, message, defaultValue, resolve });
    });
  }, []);

  const showAlert = useCallback((msg) => showModal('alert', msg), [showModal]);
  const showConfirm = useCallback((msg) => showModal('confirm', msg), [showModal]);
  const showPrompt = useCallback((msg, defaultValue) => showModal('prompt', msg, defaultValue), [showModal]);

  const handleClose = useCallback((value) => {
    if (modal) {
      modal.resolve(value);
      setModal(null);
    }
  }, [modal]);

  return (
    <>
      {children}
      {modal && <ModalDialog modal={modal} onClose={handleClose} />}
    </>
  );
}

export function useModal() {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('useModal must be used within ModalProvider');
  return ctx;
}

// Re-export with context wiring
export function ModalProviderWithContext({ children }) {
  const [modal, setModal] = useState(null);

  const showModal = useCallback((type, message, defaultValue) => {
    return new Promise((resolve) => {
      setModal({ type, message, defaultValue, resolve });
    });
  }, []);

  const showAlert = useCallback((msg) => showModal('alert', msg), [showModal]);
  const showConfirm = useCallback((msg) => showModal('confirm', msg), [showModal]);
  const showPrompt = useCallback((msg, defaultValue) => showModal('prompt', msg, defaultValue), [showModal]);

  const handleClose = useCallback((value) => {
    if (modal) {
      modal.resolve(value);
      setModal(null);
    }
  }, [modal]);

  return (
    <ModalContext.Provider value={{ showAlert, showConfirm, showPrompt }}>
      {children}
      {modal && <ModalDialog modal={modal} onClose={handleClose} />}
    </ModalContext.Provider>
  );
}

function ModalDialog({ modal, onClose }) {
  const [inputValue, setInputValue] = useState(modal.defaultValue || '');

  return (
    <div
      className="modal-overlay"
      onClick={() => {
        if (modal.type === 'alert') onClose(undefined);
        else if (modal.type === 'confirm') onClose(false);
        else onClose(null);
      }}
    >
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-message">{modal.message}</div>
        {modal.type === 'prompt' && (
          <input
            className="modal-input"
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onClose(inputValue);
            }}
            autoFocus
          />
        )}
        <div className="modal-actions">
          {modal.type === 'alert' && (
            <button
              className="modal-btn modal-btn-primary"
              onClick={() => onClose(undefined)}
              autoFocus
            >
              确定
            </button>
          )}
          {modal.type === 'confirm' && (
            <>
              <button className="modal-btn modal-btn-cancel" onClick={() => onClose(false)}>
                取消
              </button>
              <button
                className="modal-btn modal-btn-primary"
                onClick={() => onClose(true)}
                autoFocus
              >
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
