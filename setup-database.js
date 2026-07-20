require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function setupDatabase() {
  console.log('🦷 BloomDent 데이터베이스 설정을 시작합니다...\n');

  // 환경 변수 확인
  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
    console.error('❌ .env 파일을 확인해주세요. DB_HOST, DB_USER, DB_NAME이 필요합니다.');
    process.exit(1);
  }

  console.log('📊 데이터베이스 정보:');
  console.log(`   Host: ${process.env.DB_HOST}`);
  console.log(`   Port: ${process.env.DB_PORT || 3306}`);
  console.log(`   Database: ${process.env.DB_NAME}`);
  console.log(`   User: ${process.env.DB_USER}\n`);

  let connection;

  try {
    // MariaDB 연결 (데이터베이스 선택 없이)
    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD || '',
      multipleStatements: true
    });

    console.log('✅ MariaDB 연결 성공!\n');

    // 데이터베이스 존재 확인 및 생성
    console.log('🗄️  데이터베이스 확인 중...');
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`✅ 데이터베이스 '${process.env.DB_NAME}' 준비 완료\n`);

    // 데이터베이스 선택
    await connection.query(`USE ${process.env.DB_NAME}`);

    // 기존 테이블 삭제 (외래키 제약 조건 때문에 순서 중요)
    console.log('🗑️  기존 테이블 삭제 중...');
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    await connection.query('DROP TABLE IF EXISTS score_history');
    await connection.query('DROP TABLE IF EXISTS user_health_scores');
    await connection.query('DROP TABLE IF EXISTS user_survey_responses');
    await connection.query('DROP TABLE IF EXISTS survey_question_options');
    await connection.query('DROP TABLE IF EXISTS survey_questions_master');
    await connection.query('DROP TABLE IF EXISTS image_analysis');
    await connection.query('DROP TABLE IF EXISTS dental_images');
    await connection.query('DROP TABLE IF EXISTS appointment_surveys');
    await connection.query('DROP TABLE IF EXISTS appointments');
    await connection.query('DROP TABLE IF EXISTS survey_questions');
    await connection.query('DROP TABLE IF EXISTS appointment_slots');
    await connection.query('DROP TABLE IF EXISTS dental_clinics');
    await connection.query('DROP TABLE IF EXISTS self_check');
    await connection.query('DROP TABLE IF EXISTS users');
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log('✅ 기존 테이블 삭제 완료\n');

    // 스키마 파일 읽기 및 실행
    console.log('🔧 스키마 생성 중...');
    const schemaPath = path.join(__dirname, 'database', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    await connection.query(schema);
    console.log('✅ 스키마 생성 완료\n');

    // 샘플 데이터 파일 읽기 및 실행
    console.log('📝 샘플 데이터 삽입 중...');
    const seedPath = path.join(__dirname, 'database', 'seed_data.sql');
    const seedData = fs.readFileSync(seedPath, 'utf8');
    
    await connection.query(seedData);
    console.log('✅ 샘플 데이터 삽입 완료\n');

    // 설문 샘플 데이터 삽입
    console.log('📋 설문 데이터 삽입 중...');
    const seedSurveyPath = path.join(__dirname, 'database', 'seed_survey_data.sql');
    const seedSurveyData = fs.readFileSync(seedSurveyPath, 'utf8');
    
    await connection.query(seedSurveyData);
    console.log('✅ 설문 데이터 삽입 완료\n');

    // 자가진단 문진표(15문항) 삽입 - 동적설문(survey_questions/options)
    console.log('📋 자가진단 문진표(15문항) 삽입 중...');
    const seedQuestionnairePath = path.join(__dirname, 'database', 'seed_survey_questionnaire.sql');
    const seedQuestionnaire = fs.readFileSync(seedQuestionnairePath, 'utf8');

    await connection.query(seedQuestionnaire);
    console.log('✅ 자가진단 문진표 삽입 완료\n');

    // 테이블 확인
    console.log('📋 생성된 테이블 목록:');
    const [tables] = await connection.query('SHOW TABLES');
    tables.forEach(table => {
      const tableName = Object.values(table)[0];
      console.log(`   - ${tableName}`);
    });

    console.log('\n🎉 데이터베이스 설정이 완료되었습니다!\n');
    console.log('다음 명령어로 서버를 시작하세요:');
    console.log('  npm run dev\n');

  } catch (error) {
    console.error('\n❌ 오류가 발생했습니다:');
    console.error(error.message);
    
    if (error.code === 'ENOTFOUND') {
      console.error('\n💡 데이터베이스 호스트에 연결할 수 없습니다. .env 파일의 DB_HOST를 확인해주세요.');
    } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('\n💡 데이터베이스 접근이 거부되었습니다. .env 파일의 DB_USER와 DB_PASSWORD를 확인해주세요.');
    }
    
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

setupDatabase();

