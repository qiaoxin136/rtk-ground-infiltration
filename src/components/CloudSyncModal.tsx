import React, { useEffect, useState } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { Cloud, Cpu, Database, FolderOpen, Save, X } from 'lucide-react';
import {
  invokeLambdaFullCalibration,
  isAmplifyConfigured,
  listSavedProjects,
  loadCloudTelemetryFiles,
  saveCalibrationRecord,
  type SavedBasinRecord,
} from '../lib/amplifyCloud';
import type { AnalysisConfig, AreaUnit, FlowUnit, FullAnalysisResult, RainUnit } from '../engine/types';

interface CloudSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentResult: FullAnalysisResult | null;
  flowFileName: string;
  rainFileName: string;
  flowRawText: string;
  rainRawText: string;
  onLambdaResult: (result: FullAnalysisResult, computeMs: number) => void;
  onLoadCloudRecord: (payload: {
    flowText: string;
    rainText: string;
    flowFileName: string;
    rainFileName: string;
    partialConfig: Partial<AnalysisConfig>;
  }) => void;
}

export const CloudSyncModal: React.FC<CloudSyncModalProps> = ({
  isOpen,
  onClose,
  currentResult,
  flowFileName,
  rainFileName,
  flowRawText,
  rainRawText,
  onLambdaResult,
  onLoadCloudRecord,
}) => {
  const [records, setRecords] = useState<SavedBasinRecord[]>([]);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [showAuthBox, setShowAuthBox] = useState(false);

  const refreshList = async () => {
    const items = await listSavedProjects();
    setRecords(items);
  };

  useEffect(() => {
    if (isOpen) {
      refreshList();
      setStatusNotice(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = async () => {
    if (!currentResult) return;
    setBusyMsg('Saving basin calibration & telemetry...');
    try {
      const saved = await saveCalibrationRecord(
        currentResult,
        flowFileName,
        rainFileName,
        flowRawText,
        rainRawText
      );
      await refreshList();
      setStatusNotice(
        saved.source === 'amplify-cloud'
          ? `Saved "${saved.projectName}" to AWS Amplify DynamoDB + S3 Storage.`
          : `Saved "${saved.projectName}" to browser registry (connect Amplify sandbox to sync to AWS).`
      );
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  const handleLambdaVerify = async () => {
    if (!currentResult) return;
    setBusyMsg('Executing full RTK + InfoWorks ICM GIM calibration on AWS Lambda...');
    try {
      const res = await invokeLambdaFullCalibration(flowRawText, rainRawText, currentResult.config);
      onLambdaResult(res.result, res.computeMs);
      setStatusNotice(
        `AWS Lambda rtk-gim-calibrator completed full calibration in ${(res.computeMs / 1000).toFixed(2)}s (${res.transport}).`
      );
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  const handleOpenRecord = async (rec: SavedBasinRecord) => {
    setBusyMsg(`Loading "${rec.projectName}"...`);
    try {
      const files = await loadCloudTelemetryFiles(rec);
      if (files) {
        onLoadCloudRecord({
          flowText: files.flowText,
          rainText: files.rainText,
          flowFileName: rec.flowFileName,
          rainFileName: rec.rainFileName,
          partialConfig: {
            projectName: rec.projectName,
            areaValue: rec.areaValue,
            areaUnit: rec.areaUnit as AreaUnit,
            baselineFlowMgd: rec.baselineFlowMgd ?? 0,
            flowUnit: rec.flowUnit as FlowUnit,
            rainUnit: rec.rainUnit as RainUnit,
          },
        });
        onClose();
      } else {
        setStatusNotice(
          `Restored parameters for "${rec.projectName}" (DWF=${rec.weightedDwfMgd.toFixed(
            3
          )} MGD, Daily NSE=${rec.nseDaily.toFixed(3)}).`
        );
      }
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="eyebrow-tag">AWS AMPLIFY GEN 2 BACKEND</div>
            <h3 className="panel-title">Cloud Basin Registry, S3 Telemetry &amp; Lambda Compute</h3>
          </div>
          <button type="button" className="icon-close-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="cloud-status-banner">
          <Cloud size={18} />
          <div>
            <strong>
              Status:{' '}
              {isAmplifyConfigured
                ? 'Connected to AWS Amplify (AppSync GraphQL + S3 + Lambda + Cognito)'
                : 'Local Standalone Mode (amplify_outputs.json not generated yet)'}
            </strong>
            <p>
              {isAmplifyConfigured
                ? 'Uploaded rainfall/flow files sync to S3 (rtkHydrologyStorage) and calibrated ICM models persist in DynamoDB.'
                : 'Deploy this repository in AWS Amplify Console or run `npx ampx sandbox` locally to activate live S3, DynamoDB, Cognito Auth, and Lambda compute.'}
            </p>
          </div>
        </div>

        <div className="cloud-action-row">
          <button
            type="button"
            className="btn-primary"
            disabled={!currentResult || Boolean(busyMsg)}
            onClick={handleSave}
          >
            <Save size={14} /> Save Current Basin Run
          </button>

          {isAmplifyConfigured && (
            <>
              <button
                type="button"
                className="btn-secondary"
                disabled={!currentResult || Boolean(busyMsg)}
                onClick={handleLambdaVerify}
              >
                <Cpu size={14} /> Run on AWS Lambda
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowAuthBox((v) => !v)}
              >
                {showAuthBox ? 'Hide Account Sign-In' : 'Cognito Account Sign-In'}
              </button>
            </>
          )}
        </div>

        {busyMsg && <div className="cloud-notice busy">{busyMsg}</div>}
        {statusNotice && <div className="cloud-notice">{statusNotice}</div>}

        {isAmplifyConfigured && showAuthBox && (
          <div className="auth-embed-box">
            <Authenticator loginMechanisms={['email']}>
              {({ signOut, user }) => (
                <div className="signed-in-bar">
                  <span>Signed in as {user?.signInDetails?.loginId ?? user?.username}</span>
                  <button type="button" className="btn-secondary" onClick={signOut}>
                    Sign out
                  </button>
                </div>
              )}
            </Authenticator>
          </div>
        )}

        <div className="saved-list-section">
          <h4 className="saved-list-heading">
            <Database size={14} /> Saved Calibration Runs ({records.length})
          </h4>
          {records.length === 0 ? (
            <div className="empty-callout">
              No saved basin runs yet. Click <strong>Save Current Basin Run</strong> above to store
              your calibrated RTK &amp; InfoWorks ICM parameters.
            </div>
          ) : (
            <div className="table-scroll-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Basin / Project</th>
                    <th>Area</th>
                    <th>DWF (MGD)</th>
                    <th>Storms</th>
                    <th>Daily NSE</th>
                    <th>Source</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.id}>
                      <td className="strong-cell">{r.projectName}</td>
                      <td className="mono-cell">
                        {r.areaValue} {r.areaUnit}
                      </td>
                      <td className="mono-cell num">{r.weightedDwfMgd.toFixed(3)}</td>
                      <td className="mono-cell num">{r.eventCount}</td>
                      <td className="mono-cell num strong">{r.nseDaily.toFixed(3)}</td>
                      <td>
                        <span className="icm-obj-pill">
                          {r.source === 'amplify-cloud' ? 'AWS Cloud' : 'Local'}
                        </span>
                      </td>
                      <td>
                        {r.flowStoragePath && r.rainStoragePath && (
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => handleOpenRecord(r)}
                          >
                            <FolderOpen size={13} /> Load
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
