import { useState } from 'react';
import { labTools, runLab, type LabResult } from './labs';
import { saveBlob } from '../utils/download';
export function TechnicalLab() {
  const [tool, setTool] = useState('snippet');
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<LabResult | null>(null);
  const [error, setError] = useState('');
  const selected = labTools.find((t) => t.id === tool)!;
  return (
    <section>
      <header className="discovery-section-heading">
        <div>
          <h2>Technical lab</h2>
          <p>Inspect and prepare small changes locally. Nothing is published or submitted.</p>
        </div>
        <label>
          Tool
          <select
            aria-label="Technical tool"
            value={tool}
            onChange={(e) => {
              setTool(e.target.value);
              setValues({});
              setResult(null);
              setError('');
            }}
          >
            {labTools.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      <p className="discovery-note">{selected.note}</p>
      <div className="discovery-opportunities">
        <div className="discovery-panel">
          <div className="discovery-form">
            {selected.fields.map((field) => (
              <label key={field.key}>
                {field.label}
                {field.multiline ? (
                  <textarea
                    maxLength={200000}
                    rows={7}
                    value={values[field.key] || ''}
                    onChange={(e) => {
                      setValues((v) => ({ ...v, [field.key]: e.target.value }));
                      setResult(null);
                    }}
                  />
                ) : (
                  <input
                    value={values[field.key] || ''}
                    onChange={(e) => {
                      setValues((v) => ({ ...v, [field.key]: e.target.value }));
                      setResult(null);
                    }}
                  />
                )}
              </label>
            ))}
          </div>
          <button
            className="btn btn-primary"
            onClick={() => {
              try {
                setResult(runLab(tool, values));
                setError('');
              } catch (e) {
                setError(String(e));
                setResult(null);
              }
            }}
          >
            Check & prepare
          </button>
          {error && (
            <p role="alert" className="discovery-error">
              {error}
            </p>
          )}
        </div>
        <div className="discovery-panel">
          <h3>Result</h3>
          {tool === 'snippet' && (
            <div className="discovery-snippet">
              <small>{values.url || 'https://example.com/'}</small>
              <h3>{values.title || 'Your page title'}</h3>
              <p>{values.description || 'Your description preview will appear here.'}</p>
            </div>
          )}
          {result ? (
            <>
              <ul>
                {result.summary.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              <pre style={{ whiteSpace: 'pre-wrap' }}>{result.output}</pre>
              <button
                className="btn btn-secondary"
                onClick={() => saveBlob(new Blob([result.output], { type: 'text/plain' }), `${tool}.txt`)}
              >
                Download result
              </button>
            </>
          ) : (
            <p>Enter the details and run a check to see the result.</p>
          )}
        </div>
      </div>
    </section>
  );
}
