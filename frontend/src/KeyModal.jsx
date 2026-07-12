// Shown once, right after an instance is created and its private key has been
// auto-downloaded. Warns the user the key cannot be retrieved again.
export default function KeyModal({ info, onClose }) {
  if (!info) return null;
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal key-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="key-modal-icon">🔑</div>
        <h2 className="key-modal-title">Key pair downloaded</h2>
        <p className="key-modal-sub">
          A private key for <strong>{info.instanceName}</strong> was generated and
          your browser has downloaded it as:
        </p>

        <div className="key-file">
          <span className="key-file-icon">📄</span>
          <code>{info.filename}</code>
        </div>

        <div className="key-warn">
          <span className="key-warn-icon">⚠️</span>
          <div>
            <strong>Store this key somewhere safe — you cannot download it again.</strong>
            <p>
              This is the only copy. The server does not keep it. If you lose it,
              you will not be able to SSH into this instance with this key pair.
            </p>
          </div>
        </div>

        <div className="key-usage">
          <div className="key-usage-title">Connect from your terminal</div>
          <pre>
{`chmod 400 ${info.filename}
ssh -i ${info.filename} ubuntu@${info.ipAddress || "<instance-ip>"}`}
          </pre>
        </div>

        <div className="key-modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            I've saved my key
          </button>
        </div>
      </div>
    </div>
  );
}
