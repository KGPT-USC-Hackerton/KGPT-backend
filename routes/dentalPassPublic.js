const express = require('express');
const router = express.Router();
const noStoreCache = require('../middleware/noStoreCache');
const dentalPassController = require('../agent/controllers/dentalPassController');

// CLAUDE.md 예외(명시적): "New Agent endpoints must be exposed only under /api/agent"
// 원칙에 대한 예외다. Dental Pass 공개 조회는 병원 접수 데스크가 로그인 없이
// Share Token만으로 여는 공유 리소스이므로 Demo Auth(agentDemoAuth)를 적용할 수
// 없다. routes/agent.js와 같은 라우터에 두면 등록 순서에 인증 여부가 의존하게
// 되므로, 이 위험을 없애기 위해 완전히 분리된 라우터 파일로 만들어 server.js에서
// /api/dental-pass 로 직접 마운트한다. 생성(POST)·철회(DELETE)는 여전히
// routes/agent.js(/api/agent 하위, Demo Auth 필요)에만 존재한다.
router.get('/:shareToken', noStoreCache, dentalPassController.getPublicDentalPass);

module.exports = router;
