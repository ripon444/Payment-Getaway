plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
}

android {
    namespace = "bd.takaledger.agent"
    compileSdk = 34

    defaultConfig {
        applicationId = "bd.takaledger.agent"
        minSdk = 26
        targetSdk = 34
        versionCode = 142
        versionName = "1.4.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // WorkManager for reliable offline queue sync
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // Room SQLite for persistent offline notification queue
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // EncryptedSharedPreferences backed by Android Keystore
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // OkHttp + JSON
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
