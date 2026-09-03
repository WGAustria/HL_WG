import { upload } from '@vercel/blob/client';

// Wird als IIFE gebaut (siehe package.json build-Skript) und direkt im
// Browser eingebunden - stellt window.vercelBlobUpload bereit, damit
// index.html grosse Dateien ohne Bundler/Build-Step direkt zu Vercel Blob
// hochladen kann (umgeht das 4.5MB-Limit fuer Vercel Serverless Functions).
window.vercelBlobUpload = upload;
