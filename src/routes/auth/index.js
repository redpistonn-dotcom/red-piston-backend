import { Router } from 'express';
import otpRoutes from './otp.js';
import firebaseRoutes from './firebase.js';
import emailRoutes from './email.js';
import passwordRoutes from './password.js';
import sessionRoutes from './session.js';
import profileRoutes from './profile.js';
import providerRoutes from './providers.js';
import shopSetupRoutes from './shopSetup.js';

const router = Router();

router.use(otpRoutes);
router.use(firebaseRoutes);
router.use(emailRoutes);
router.use(passwordRoutes);
router.use(sessionRoutes);
router.use(profileRoutes);
router.use(providerRoutes);
router.use(shopSetupRoutes);

export default router;
