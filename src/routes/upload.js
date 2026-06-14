/**
 * POST /api/upload/signature   — generate a signed Cloudinary upload params set
 * DELETE /api/upload/:publicId — delete an asset from Cloudinary by public_id
 *
 * Clients upload directly to Cloudinary using the signature; they never send
 * the binary to this server. Once the upload succeeds, the client POSTs the
 * returned secure_url to the relevant data endpoint (e.g. PUT /api/catalog/:id).
 */
import express from 'express';
import { v2 as cloudinary } from 'cloudinary';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// Configure Cloudinary from env vars
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * GET /api/upload/signature?folder=products
 * Returns { signature, timestamp, apiKey, cloudName, folder }
 * Frontend uses these to POST directly to Cloudinary's upload endpoint.
 */
router.get('/signature', authenticate, (req, res) => {
  try {
    // Fail loudly (and diagnosably) if Cloudinary isn't configured, instead of
    // returning a signature signed with `undefined` that Cloudinary later rejects
    // as "Invalid Signature" — which looks like a silently broken uploader.
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      console.error('[upload/signature] Cloudinary env vars missing — uploads disabled');
      return res.status(503).json({
        error: 'Image upload is not configured on the server (missing CLOUDINARY_* env vars).',
      });
    }
    const folder    = req.query.folder || 'redpiston';
    const timestamp = Math.round(Date.now() / 1000);
    const params    = { timestamp, folder };

    const signature = cloudinary.utils.api_sign_request(
      params,
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      signature,
      timestamp,
      apiKey:    process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      folder,
    });
  } catch (err) {
    console.error('[upload/signature]', err);
    res.status(500).json({ error: 'Failed to generate upload signature' });
  }
});

/**
 * DELETE /api/upload/:publicId
 * Deletes an asset from Cloudinary. publicId may contain slashes (e.g. "redpiston/abc123").
 * Pass it URL-encoded in the path.
 *
 * Authorization: the publicId MUST start with a shop-scoped prefix
 * ("shop-<shopId>/", "bills/shop-<shopId>/", or "redpiston/") owned by the caller,
 * or the caller must be a PLATFORM_ADMIN.  This prevents authenticated users from
 * deleting assets belonging to other shops.
 */
router.delete('/:publicId(*)', authenticate, async (req, res) => {
  try {
    const publicId = req.params.publicId;
    const role = req.user.userType?.slug || req.user.role;
    const shopId = req.user.shopId;

    // Authorization: verify the publicId belongs to the caller's shop
    if (role !== 'PLATFORM_ADMIN') {
      // Allowed prefixes for a shop owner
      const allowedPrefixes = [
        `shop-${shopId}/`,
        `bills/shop-${shopId}/`,
        `redpiston/shop-${shopId}/`,
        // avatars are stored per-user: "redpiston/users/<userId>/"
        `redpiston/users/${req.user.userId}/`,
      ];
      const isAllowed = allowedPrefixes.some(prefix => publicId.startsWith(prefix));
      if (!isAllowed) {
        return res.status(403).json({ error: 'You do not have permission to delete this asset' });
      }
    }

    const result = await cloudinary.uploader.destroy(publicId);

    if (result.result !== 'ok' && result.result !== 'not found') {
      return res.status(400).json({ error: 'Cloudinary deletion failed', detail: result });
    }
    res.json({ deleted: true, publicId });
  } catch (err) {
    console.error('[upload/delete]', err);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

export default router;
