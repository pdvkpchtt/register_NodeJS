import { Router } from "express";

const router = Router();

// GET /checkhealth — информация о доступности бэкенда
router.get("/checkhealth", async (req, res) => {
  res.send("ok");
});

export default router;
