var Deserializers = {}
Deserializers["UnityEngine.JointSpring"] = function (request, data, root) {
  var i370940 = root || request.c( 'UnityEngine.JointSpring' )
  var i370941 = data
  i370940.spring = i370941[0]
  i370940.damper = i370941[1]
  i370940.targetPosition = i370941[2]
  return i370940
}

Deserializers["UnityEngine.JointMotor"] = function (request, data, root) {
  var i370942 = root || request.c( 'UnityEngine.JointMotor' )
  var i370943 = data
  i370942.m_TargetVelocity = i370943[0]
  i370942.m_Force = i370943[1]
  i370942.m_FreeSpin = i370943[2]
  return i370942
}

Deserializers["UnityEngine.JointLimits"] = function (request, data, root) {
  var i370944 = root || request.c( 'UnityEngine.JointLimits' )
  var i370945 = data
  i370944.m_Min = i370945[0]
  i370944.m_Max = i370945[1]
  i370944.m_Bounciness = i370945[2]
  i370944.m_BounceMinVelocity = i370945[3]
  i370944.m_ContactDistance = i370945[4]
  i370944.minBounce = i370945[5]
  i370944.maxBounce = i370945[6]
  return i370944
}

Deserializers["UnityEngine.JointDrive"] = function (request, data, root) {
  var i370946 = root || request.c( 'UnityEngine.JointDrive' )
  var i370947 = data
  i370946.m_PositionSpring = i370947[0]
  i370946.m_PositionDamper = i370947[1]
  i370946.m_MaximumForce = i370947[2]
  i370946.m_UseAcceleration = i370947[3]
  return i370946
}

Deserializers["UnityEngine.SoftJointLimitSpring"] = function (request, data, root) {
  var i370948 = root || request.c( 'UnityEngine.SoftJointLimitSpring' )
  var i370949 = data
  i370948.m_Spring = i370949[0]
  i370948.m_Damper = i370949[1]
  return i370948
}

Deserializers["UnityEngine.SoftJointLimit"] = function (request, data, root) {
  var i370950 = root || request.c( 'UnityEngine.SoftJointLimit' )
  var i370951 = data
  i370950.m_Limit = i370951[0]
  i370950.m_Bounciness = i370951[1]
  i370950.m_ContactDistance = i370951[2]
  return i370950
}

Deserializers["UnityEngine.WheelFrictionCurve"] = function (request, data, root) {
  var i370952 = root || request.c( 'UnityEngine.WheelFrictionCurve' )
  var i370953 = data
  i370952.m_ExtremumSlip = i370953[0]
  i370952.m_ExtremumValue = i370953[1]
  i370952.m_AsymptoteSlip = i370953[2]
  i370952.m_AsymptoteValue = i370953[3]
  i370952.m_Stiffness = i370953[4]
  return i370952
}

Deserializers["UnityEngine.JointAngleLimits2D"] = function (request, data, root) {
  var i370954 = root || request.c( 'UnityEngine.JointAngleLimits2D' )
  var i370955 = data
  i370954.m_LowerAngle = i370955[0]
  i370954.m_UpperAngle = i370955[1]
  return i370954
}

Deserializers["UnityEngine.JointMotor2D"] = function (request, data, root) {
  var i370956 = root || request.c( 'UnityEngine.JointMotor2D' )
  var i370957 = data
  i370956.m_MotorSpeed = i370957[0]
  i370956.m_MaximumMotorTorque = i370957[1]
  return i370956
}

Deserializers["UnityEngine.JointSuspension2D"] = function (request, data, root) {
  var i370958 = root || request.c( 'UnityEngine.JointSuspension2D' )
  var i370959 = data
  i370958.m_DampingRatio = i370959[0]
  i370958.m_Frequency = i370959[1]
  i370958.m_Angle = i370959[2]
  return i370958
}

Deserializers["UnityEngine.JointTranslationLimits2D"] = function (request, data, root) {
  var i370960 = root || request.c( 'UnityEngine.JointTranslationLimits2D' )
  var i370961 = data
  i370960.m_LowerTranslation = i370961[0]
  i370960.m_UpperTranslation = i370961[1]
  return i370960
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Mesh"] = function (request, data, root) {
  var i370962 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Mesh' )
  var i370963 = data
  i370962.name = i370963[0]
  i370962.halfPrecision = !!i370963[1]
  i370962.useUInt32IndexFormat = !!i370963[2]
  i370962.vertexCount = i370963[3]
  i370962.aabb = i370963[4]
  var i370965 = i370963[5]
  var i370964 = []
  for(var i = 0; i < i370965.length; i += 1) {
    i370964.push( !!i370965[i + 0] );
  }
  i370962.streams = i370964
  i370962.vertices = i370963[6]
  var i370967 = i370963[7]
  var i370966 = []
  for(var i = 0; i < i370967.length; i += 1) {
    i370966.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Mesh+SubMesh', i370967[i + 0]) );
  }
  i370962.subMeshes = i370966
  var i370969 = i370963[8]
  var i370968 = []
  for(var i = 0; i < i370969.length; i += 16) {
    i370968.push( new pc.Mat4().setData(i370969[i + 0], i370969[i + 1], i370969[i + 2], i370969[i + 3],  i370969[i + 4], i370969[i + 5], i370969[i + 6], i370969[i + 7],  i370969[i + 8], i370969[i + 9], i370969[i + 10], i370969[i + 11],  i370969[i + 12], i370969[i + 13], i370969[i + 14], i370969[i + 15]) );
  }
  i370962.bindposes = i370968
  var i370971 = i370963[9]
  var i370970 = []
  for(var i = 0; i < i370971.length; i += 1) {
    i370970.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Mesh+BlendShape', i370971[i + 0]) );
  }
  i370962.blendShapes = i370970
  return i370962
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Mesh+SubMesh"] = function (request, data, root) {
  var i370976 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Mesh+SubMesh' )
  var i370977 = data
  i370976.triangles = i370977[0]
  return i370976
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Mesh+BlendShape"] = function (request, data, root) {
  var i370982 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Mesh+BlendShape' )
  var i370983 = data
  i370982.name = i370983[0]
  var i370985 = i370983[1]
  var i370984 = []
  for(var i = 0; i < i370985.length; i += 1) {
    i370984.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Mesh+BlendShapeFrame', i370985[i + 0]) );
  }
  i370982.frames = i370984
  return i370982
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Material"] = function (request, data, root) {
  var i370986 = root || new pc.UnityMaterial()
  var i370987 = data
  i370986.name = i370987[0]
  request.r(i370987[1], i370987[2], 0, i370986, 'shader')
  i370986.renderQueue = i370987[3]
  i370986.enableInstancing = !!i370987[4]
  var i370989 = i370987[5]
  var i370988 = []
  for(var i = 0; i < i370989.length; i += 1) {
    i370988.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Material+FloatParameter', i370989[i + 0]) );
  }
  i370986.floatParameters = i370988
  var i370991 = i370987[6]
  var i370990 = []
  for(var i = 0; i < i370991.length; i += 1) {
    i370990.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Material+ColorParameter', i370991[i + 0]) );
  }
  i370986.colorParameters = i370990
  var i370993 = i370987[7]
  var i370992 = []
  for(var i = 0; i < i370993.length; i += 1) {
    i370992.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Material+VectorParameter', i370993[i + 0]) );
  }
  i370986.vectorParameters = i370992
  var i370995 = i370987[8]
  var i370994 = []
  for(var i = 0; i < i370995.length; i += 1) {
    i370994.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Material+TextureParameter', i370995[i + 0]) );
  }
  i370986.textureParameters = i370994
  var i370997 = i370987[9]
  var i370996 = []
  for(var i = 0; i < i370997.length; i += 1) {
    i370996.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Material+MaterialFlag', i370997[i + 0]) );
  }
  i370986.materialFlags = i370996
  return i370986
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Material+FloatParameter"] = function (request, data, root) {
  var i371000 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Material+FloatParameter' )
  var i371001 = data
  i371000.name = i371001[0]
  i371000.value = i371001[1]
  return i371000
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Material+ColorParameter"] = function (request, data, root) {
  var i371004 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Material+ColorParameter' )
  var i371005 = data
  i371004.name = i371005[0]
  i371004.value = new pc.Color(i371005[1], i371005[2], i371005[3], i371005[4])
  return i371004
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Material+VectorParameter"] = function (request, data, root) {
  var i371008 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Material+VectorParameter' )
  var i371009 = data
  i371008.name = i371009[0]
  i371008.value = new pc.Vec4( i371009[1], i371009[2], i371009[3], i371009[4] )
  return i371008
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Material+TextureParameter"] = function (request, data, root) {
  var i371012 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Material+TextureParameter' )
  var i371013 = data
  i371012.name = i371013[0]
  request.r(i371013[1], i371013[2], 0, i371012, 'value')
  return i371012
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Material+MaterialFlag"] = function (request, data, root) {
  var i371016 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Material+MaterialFlag' )
  var i371017 = data
  i371016.name = i371017[0]
  i371016.enabled = !!i371017[1]
  return i371016
}

Deserializers["Luna.Unity.DTO.UnityEngine.Textures.Texture2D"] = function (request, data, root) {
  var i371018 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Textures.Texture2D' )
  var i371019 = data
  i371018.name = i371019[0]
  i371018.width = i371019[1]
  i371018.height = i371019[2]
  i371018.mipmapCount = i371019[3]
  i371018.anisoLevel = i371019[4]
  i371018.filterMode = i371019[5]
  i371018.hdr = !!i371019[6]
  i371018.format = i371019[7]
  i371018.wrapMode = i371019[8]
  i371018.alphaIsTransparency = !!i371019[9]
  i371018.alphaSource = i371019[10]
  i371018.graphicsFormat = i371019[11]
  i371018.sRGBTexture = !!i371019[12]
  i371018.desiredColorSpace = i371019[13]
  i371018.wrapU = i371019[14]
  i371018.wrapV = i371019[15]
  return i371018
}

Deserializers["Luna.Unity.DTO.UnityEngine.Textures.Cubemap"] = function (request, data, root) {
  var i371020 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Textures.Cubemap' )
  var i371021 = data
  i371020.name = i371021[0]
  i371020.atlasId = i371021[1]
  i371020.mipmapCount = i371021[2]
  i371020.hdr = !!i371021[3]
  i371020.size = i371021[4]
  i371020.anisoLevel = i371021[5]
  i371020.filterMode = i371021[6]
  var i371023 = i371021[7]
  var i371022 = []
  for(var i = 0; i < i371023.length; i += 4) {
    i371022.push( UnityEngine.Rect.MinMaxRect(i371023[i + 0], i371023[i + 1], i371023[i + 2], i371023[i + 3]) );
  }
  i371020.rects = i371022
  i371020.wrapU = i371021[8]
  i371020.wrapV = i371021[9]
  return i371020
}

Deserializers["Luna.Unity.DTO.UnityEngine.Scene.Scene"] = function (request, data, root) {
  var i371026 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Scene.Scene' )
  var i371027 = data
  i371026.name = i371027[0]
  i371026.index = i371027[1]
  i371026.startup = !!i371027[2]
  return i371026
}

Deserializers["Luna.Unity.DTO.UnityEngine.Components.Transform"] = function (request, data, root) {
  var i371028 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Components.Transform' )
  var i371029 = data
  i371028.position = new pc.Vec3( i371029[0], i371029[1], i371029[2] )
  i371028.scale = new pc.Vec3( i371029[3], i371029[4], i371029[5] )
  i371028.rotation = new pc.Quat(i371029[6], i371029[7], i371029[8], i371029[9])
  return i371028
}

Deserializers["Luna.Unity.DTO.UnityEngine.Components.Camera"] = function (request, data, root) {
  var i371030 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Components.Camera' )
  var i371031 = data
  i371030.aspect = i371031[0]
  i371030.orthographic = !!i371031[1]
  i371030.orthographicSize = i371031[2]
  i371030.backgroundColor = new pc.Color(i371031[3], i371031[4], i371031[5], i371031[6])
  i371030.nearClipPlane = i371031[7]
  i371030.farClipPlane = i371031[8]
  i371030.fieldOfView = i371031[9]
  i371030.depth = i371031[10]
  i371030.clearFlags = i371031[11]
  i371030.cullingMask = i371031[12]
  i371030.rect = i371031[13]
  request.r(i371031[14], i371031[15], 0, i371030, 'targetTexture')
  i371030.usePhysicalProperties = !!i371031[16]
  i371030.focalLength = i371031[17]
  i371030.sensorSize = new pc.Vec2( i371031[18], i371031[19] )
  i371030.lensShift = new pc.Vec2( i371031[20], i371031[21] )
  i371030.gateFit = i371031[22]
  i371030.commandBufferCount = i371031[23]
  i371030.cameraType = i371031[24]
  i371030.enabled = !!i371031[25]
  return i371030
}

Deserializers["Luna.Unity.DTO.UnityEngine.Scene.GameObject"] = function (request, data, root) {
  var i371032 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Scene.GameObject' )
  var i371033 = data
  i371032.name = i371033[0]
  i371032.tagId = i371033[1]
  i371032.enabled = !!i371033[2]
  i371032.isStatic = !!i371033[3]
  i371032.layer = i371033[4]
  return i371032
}

Deserializers["Luna.Unity.DTO.UnityEngine.Components.Light"] = function (request, data, root) {
  var i371034 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Components.Light' )
  var i371035 = data
  i371034.type = i371035[0]
  i371034.color = new pc.Color(i371035[1], i371035[2], i371035[3], i371035[4])
  i371034.cullingMask = i371035[5]
  i371034.intensity = i371035[6]
  i371034.range = i371035[7]
  i371034.spotAngle = i371035[8]
  i371034.shadows = i371035[9]
  i371034.shadowNormalBias = i371035[10]
  i371034.shadowBias = i371035[11]
  i371034.shadowStrength = i371035[12]
  i371034.shadowResolution = i371035[13]
  i371034.lightmapBakeType = i371035[14]
  i371034.renderMode = i371035[15]
  request.r(i371035[16], i371035[17], 0, i371034, 'cookie')
  i371034.cookieSize = i371035[18]
  i371034.enabled = !!i371035[19]
  return i371034
}

Deserializers["UnityEngine.Rendering.Universal.UniversalAdditionalLightData"] = function (request, data, root) {
  var i371036 = root || request.c( 'UnityEngine.Rendering.Universal.UniversalAdditionalLightData' )
  var i371037 = data
  i371036.m_Version = i371037[0]
  i371036.m_UsePipelineSettings = !!i371037[1]
  i371036.m_AdditionalLightsShadowResolutionTier = i371037[2]
  i371036.m_LightLayerMask = i371037[3]
  i371036.m_RenderingLayers = i371037[4]
  i371036.m_CustomShadowLayers = !!i371037[5]
  i371036.m_ShadowLayerMask = i371037[6]
  i371036.m_ShadowRenderingLayers = i371037[7]
  i371036.m_LightCookieSize = new pc.Vec2( i371037[8], i371037[9] )
  i371036.m_LightCookieOffset = new pc.Vec2( i371037[10], i371037[11] )
  i371036.m_SoftShadowQuality = i371037[12]
  return i371036
}

Deserializers["StateManager"] = function (request, data, root) {
  var i371038 = root || request.c( 'StateManager' )
  var i371039 = data
  return i371038
}

Deserializers["Luna.Unity.DTO.UnityEngine.Components.MeshFilter"] = function (request, data, root) {
  var i371040 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Components.MeshFilter' )
  var i371041 = data
  request.r(i371041[0], i371041[1], 0, i371040, 'sharedMesh')
  return i371040
}

Deserializers["Luna.Unity.DTO.UnityEngine.Components.MeshRenderer"] = function (request, data, root) {
  var i371042 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Components.MeshRenderer' )
  var i371043 = data
  request.r(i371043[0], i371043[1], 0, i371042, 'additionalVertexStreams')
  i371042.enabled = !!i371043[2]
  request.r(i371043[3], i371043[4], 0, i371042, 'sharedMaterial')
  var i371045 = i371043[5]
  var i371044 = []
  for(var i = 0; i < i371045.length; i += 2) {
  request.r(i371045[i + 0], i371045[i + 1], 2, i371044, '')
  }
  i371042.sharedMaterials = i371044
  i371042.receiveShadows = !!i371043[6]
  i371042.shadowCastingMode = i371043[7]
  i371042.sortingLayerID = i371043[8]
  i371042.sortingOrder = i371043[9]
  i371042.lightmapIndex = i371043[10]
  i371042.lightmapSceneIndex = i371043[11]
  i371042.lightmapScaleOffset = new pc.Vec4( i371043[12], i371043[13], i371043[14], i371043[15] )
  i371042.lightProbeUsage = i371043[16]
  i371042.reflectionProbeUsage = i371043[17]
  return i371042
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.RenderSettings"] = function (request, data, root) {
  var i371048 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.RenderSettings' )
  var i371049 = data
  i371048.ambientIntensity = i371049[0]
  i371048.reflectionIntensity = i371049[1]
  i371048.ambientMode = i371049[2]
  i371048.ambientLight = new pc.Color(i371049[3], i371049[4], i371049[5], i371049[6])
  i371048.ambientSkyColor = new pc.Color(i371049[7], i371049[8], i371049[9], i371049[10])
  i371048.ambientGroundColor = new pc.Color(i371049[11], i371049[12], i371049[13], i371049[14])
  i371048.ambientEquatorColor = new pc.Color(i371049[15], i371049[16], i371049[17], i371049[18])
  i371048.fogColor = new pc.Color(i371049[19], i371049[20], i371049[21], i371049[22])
  i371048.fogEndDistance = i371049[23]
  i371048.fogStartDistance = i371049[24]
  i371048.fogDensity = i371049[25]
  i371048.fog = !!i371049[26]
  request.r(i371049[27], i371049[28], 0, i371048, 'skybox')
  i371048.fogMode = i371049[29]
  var i371051 = i371049[30]
  var i371050 = []
  for(var i = 0; i < i371051.length; i += 1) {
    i371050.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.RenderSettings+Lightmap', i371051[i + 0]) );
  }
  i371048.lightmaps = i371050
  i371048.lightProbes = request.d('Luna.Unity.DTO.UnityEngine.Assets.RenderSettings+LightProbes', i371049[31], i371048.lightProbes)
  i371048.lightmapsMode = i371049[32]
  i371048.mixedBakeMode = i371049[33]
  i371048.environmentLightingMode = i371049[34]
  i371048.ambientProbe = new pc.SphericalHarmonicsL2(i371049[35])
  i371048.referenceAmbientProbe = new pc.SphericalHarmonicsL2(i371049[36])
  i371048.useReferenceAmbientProbe = !!i371049[37]
  request.r(i371049[38], i371049[39], 0, i371048, 'customReflection')
  request.r(i371049[40], i371049[41], 0, i371048, 'defaultReflection')
  i371048.defaultReflectionMode = i371049[42]
  i371048.defaultReflectionResolution = i371049[43]
  i371048.sunLightObjectId = i371049[44]
  i371048.pixelLightCount = i371049[45]
  i371048.defaultReflectionHDR = !!i371049[46]
  i371048.hasLightDataAsset = !!i371049[47]
  i371048.hasManualGenerate = !!i371049[48]
  return i371048
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.RenderSettings+Lightmap"] = function (request, data, root) {
  var i371054 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.RenderSettings+Lightmap' )
  var i371055 = data
  request.r(i371055[0], i371055[1], 0, i371054, 'lightmapColor')
  request.r(i371055[2], i371055[3], 0, i371054, 'lightmapDirection')
  return i371054
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.RenderSettings+LightProbes"] = function (request, data, root) {
  var i371056 = root || new UnityEngine.LightProbes()
  var i371057 = data
  return i371056
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.UniversalRenderPipelineAsset"] = function (request, data, root) {
  var i371064 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.UniversalRenderPipelineAsset' )
  var i371065 = data
  i371064.AdditionalLightsPerObjectLimit = i371065[0]
  i371064.AdditionalLightsRenderingMode = i371065[1]
  i371064.LightRenderingMode = request.d('Luna.Unity.DTO.UnityEngine.Assets.LightRenderingMode', i371065[2], i371064.LightRenderingMode)
  i371064.ColorGradingLutSize = i371065[3]
  i371064.ColorGradingMode = request.d('Luna.Unity.DTO.UnityEngine.Assets.ColorGradingMode', i371065[4], i371064.ColorGradingMode)
  i371064.MainLightRenderingMode = request.d('Luna.Unity.DTO.UnityEngine.Assets.LightRenderingMode', i371065[5], i371064.MainLightRenderingMode)
  i371064.MainLightRenderingModeValue = i371065[6]
  i371064.SupportsMainLightShadows = !!i371065[7]
  i371064.MixedLightingSupported = !!i371065[8]
  i371064.MsaaQuality = request.d('Luna.Unity.DTO.UnityEngine.Assets.MsaaQuality', i371065[9], i371064.MsaaQuality)
  i371064.MSAA = i371065[10]
  i371064.OpaqueDownsampling = request.d('Luna.Unity.DTO.UnityEngine.Assets.Downsampling', i371065[11], i371064.OpaqueDownsampling)
  i371064.MainLightShadowmapResolution = request.d('Luna.Unity.DTO.UnityEngine.Assets.ShadowResolution', i371065[12], i371064.MainLightShadowmapResolution)
  i371064.MainLightShadowmapResolutionValue = i371065[13]
  i371064.SupportsSoftShadows = !!i371065[14]
  i371064.SoftShadowQuality = request.d('Luna.Unity.DTO.UnityEngine.Assets.SoftShadowQuality', i371065[15], i371064.SoftShadowQuality)
  i371064.SoftShadowQualityValue = i371065[16]
  i371064.ShadowDistance = i371065[17]
  i371064.ShadowCascadeCount = i371065[18]
  i371064.Cascade2Split = i371065[19]
  i371064.Cascade3Split = new pc.Vec2( i371065[20], i371065[21] )
  i371064.Cascade4Split = new pc.Vec3( i371065[22], i371065[23], i371065[24] )
  i371064.CascadeBorder = i371065[25]
  i371064.ShadowDepthBias = i371065[26]
  i371064.ShadowNormalBias = i371065[27]
  i371064.RenderScale = i371065[28]
  i371064.RequireDepthTexture = !!i371065[29]
  i371064.RequireOpaqueTexture = !!i371065[30]
  i371064.SupportsHDR = !!i371065[31]
  i371064.SupportsTerrainHoles = !!i371065[32]
  return i371064
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.LightRenderingMode"] = function (request, data, root) {
  var i371066 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.LightRenderingMode' )
  var i371067 = data
  i371066.Disabled = i371067[0]
  i371066.PerVertex = i371067[1]
  i371066.PerPixel = i371067[2]
  return i371066
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.ColorGradingMode"] = function (request, data, root) {
  var i371068 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.ColorGradingMode' )
  var i371069 = data
  i371068.LowDynamicRange = i371069[0]
  i371068.HighDynamicRange = i371069[1]
  return i371068
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.MsaaQuality"] = function (request, data, root) {
  var i371070 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.MsaaQuality' )
  var i371071 = data
  i371070.Disabled = i371071[0]
  i371070._2x = i371071[1]
  i371070._4x = i371071[2]
  i371070._8x = i371071[3]
  return i371070
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Downsampling"] = function (request, data, root) {
  var i371072 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Downsampling' )
  var i371073 = data
  i371072.None = i371073[0]
  i371072._2xBilinear = i371073[1]
  i371072._4xBox = i371073[2]
  i371072._4xBilinear = i371073[3]
  return i371072
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.ShadowResolution"] = function (request, data, root) {
  var i371074 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.ShadowResolution' )
  var i371075 = data
  i371074._256 = i371075[0]
  i371074._512 = i371075[1]
  i371074._1024 = i371075[2]
  i371074._2048 = i371075[3]
  i371074._4096 = i371075[4]
  return i371074
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.SoftShadowQuality"] = function (request, data, root) {
  var i371076 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.SoftShadowQuality' )
  var i371077 = data
  i371076.UsePipelineSettings = i371077[0]
  i371076.Low = i371077[1]
  i371076.Medium = i371077[2]
  i371076.High = i371077[3]
  return i371076
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Shader"] = function (request, data, root) {
  var i371078 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Shader' )
  var i371079 = data
  var i371081 = i371079[0]
  var i371080 = new (System.Collections.Generic.List$1(Bridge.ns('Luna.Unity.DTO.UnityEngine.Assets.Shader+ShaderCompilationError')))
  for(var i = 0; i < i371081.length; i += 1) {
    i371080.add(request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+ShaderCompilationError', i371081[i + 0]));
  }
  i371078.ShaderCompilationErrors = i371080
  i371078.name = i371079[1]
  i371078.guid = i371079[2]
  var i371083 = i371079[3]
  var i371082 = []
  for(var i = 0; i < i371083.length; i += 1) {
    i371082.push( i371083[i + 0] );
  }
  i371078.shaderDefinedKeywords = i371082
  var i371085 = i371079[4]
  var i371084 = []
  for(var i = 0; i < i371085.length; i += 1) {
    i371084.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass', i371085[i + 0]) );
  }
  i371078.passes = i371084
  var i371087 = i371079[5]
  var i371086 = []
  for(var i = 0; i < i371087.length; i += 1) {
    i371086.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+UsePass', i371087[i + 0]) );
  }
  i371078.usePasses = i371086
  var i371089 = i371079[6]
  var i371088 = []
  for(var i = 0; i < i371089.length; i += 1) {
    i371088.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+DefaultParameterValue', i371089[i + 0]) );
  }
  i371078.defaultParameterValues = i371088
  request.r(i371079[7], i371079[8], 0, i371078, 'unityFallbackShader')
  i371078.readDepth = !!i371079[9]
  i371078.isCreatedByShaderGraph = !!i371079[10]
  i371078.disableBatching = !!i371079[11]
  i371078.compiled = !!i371079[12]
  return i371078
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Shader+ShaderCompilationError"] = function (request, data, root) {
  var i371092 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Shader+ShaderCompilationError' )
  var i371093 = data
  i371092.shaderName = i371093[0]
  i371092.errorMessage = i371093[1]
  return i371092
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass"] = function (request, data, root) {
  var i371098 = root || new pc.UnityShaderPass()
  var i371099 = data
  i371098.id = i371099[0]
  i371098.subShaderIndex = i371099[1]
  i371098.name = i371099[2]
  i371098.passType = i371099[3]
  i371098.grabPassTextureName = i371099[4]
  i371098.usePass = !!i371099[5]
  i371098.zTest = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371099[6], i371098.zTest)
  i371098.zWrite = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371099[7], i371098.zWrite)
  i371098.culling = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371099[8], i371098.culling)
  i371098.blending = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Blending', i371099[9], i371098.blending)
  i371098.alphaBlending = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Blending', i371099[10], i371098.alphaBlending)
  i371098.colorWriteMask = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371099[11], i371098.colorWriteMask)
  i371098.offsetUnits = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371099[12], i371098.offsetUnits)
  i371098.offsetFactor = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371099[13], i371098.offsetFactor)
  i371098.stencilRef = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371099[14], i371098.stencilRef)
  i371098.stencilReadMask = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371099[15], i371098.stencilReadMask)
  i371098.stencilWriteMask = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371099[16], i371098.stencilWriteMask)
  i371098.stencilOp = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+StencilOp', i371099[17], i371098.stencilOp)
  i371098.stencilOpFront = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+StencilOp', i371099[18], i371098.stencilOpFront)
  i371098.stencilOpBack = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+StencilOp', i371099[19], i371098.stencilOpBack)
  var i371101 = i371099[20]
  var i371100 = []
  for(var i = 0; i < i371101.length; i += 1) {
    i371100.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Tag', i371101[i + 0]) );
  }
  i371098.tags = i371100
  var i371103 = i371099[21]
  var i371102 = []
  for(var i = 0; i < i371103.length; i += 1) {
    i371102.push( i371103[i + 0] );
  }
  i371098.passDefinedKeywords = i371102
  var i371105 = i371099[22]
  var i371104 = []
  for(var i = 0; i < i371105.length; i += 1) {
    i371104.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+KeywordGroup', i371105[i + 0]) );
  }
  i371098.passDefinedKeywordGroups = i371104
  var i371107 = i371099[23]
  var i371106 = []
  for(var i = 0; i < i371107.length; i += 1) {
    i371106.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Variant', i371107[i + 0]) );
  }
  i371098.variants = i371106
  var i371109 = i371099[24]
  var i371108 = []
  for(var i = 0; i < i371109.length; i += 1) {
    i371108.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Variant', i371109[i + 0]) );
  }
  i371098.excludedVariants = i371108
  i371098.hasDepthReader = !!i371099[25]
  return i371098
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value"] = function (request, data, root) {
  var i371110 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value' )
  var i371111 = data
  i371110.val = i371111[0]
  i371110.name = i371111[1]
  return i371110
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Blending"] = function (request, data, root) {
  var i371112 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Blending' )
  var i371113 = data
  i371112.src = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371113[0], i371112.src)
  i371112.dst = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371113[1], i371112.dst)
  i371112.op = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371113[2], i371112.op)
  return i371112
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+StencilOp"] = function (request, data, root) {
  var i371114 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+StencilOp' )
  var i371115 = data
  i371114.pass = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371115[0], i371114.pass)
  i371114.fail = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371115[1], i371114.fail)
  i371114.zFail = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371115[2], i371114.zFail)
  i371114.comp = request.d('Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value', i371115[3], i371114.comp)
  return i371114
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Tag"] = function (request, data, root) {
  var i371118 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Tag' )
  var i371119 = data
  i371118.name = i371119[0]
  i371118.value = i371119[1]
  return i371118
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+KeywordGroup"] = function (request, data, root) {
  var i371122 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+KeywordGroup' )
  var i371123 = data
  var i371125 = i371123[0]
  var i371124 = []
  for(var i = 0; i < i371125.length; i += 1) {
    i371124.push( i371125[i + 0] );
  }
  i371122.keywords = i371124
  i371122.hasDiscard = !!i371123[1]
  return i371122
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Variant"] = function (request, data, root) {
  var i371128 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Variant' )
  var i371129 = data
  i371128.passId = i371129[0]
  i371128.subShaderIndex = i371129[1]
  var i371131 = i371129[2]
  var i371130 = []
  for(var i = 0; i < i371131.length; i += 1) {
    i371130.push( i371131[i + 0] );
  }
  i371128.keywords = i371130
  i371128.vertexProgram = i371129[3]
  i371128.fragmentProgram = i371129[4]
  i371128.exportedForWebGl2 = !!i371129[5]
  i371128.readDepth = !!i371129[6]
  return i371128
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Shader+UsePass"] = function (request, data, root) {
  var i371134 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Shader+UsePass' )
  var i371135 = data
  request.r(i371135[0], i371135[1], 0, i371134, 'shader')
  i371134.pass = i371135[2]
  return i371134
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Shader+DefaultParameterValue"] = function (request, data, root) {
  var i371138 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Shader+DefaultParameterValue' )
  var i371139 = data
  i371138.name = i371139[0]
  i371138.type = i371139[1]
  i371138.value = new pc.Vec4( i371139[2], i371139[3], i371139[4], i371139[5] )
  i371138.textureValue = i371139[6]
  i371138.shaderPropertyFlag = i371139[7]
  return i371138
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Font"] = function (request, data, root) {
  var i371140 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Font' )
  var i371141 = data
  i371140.name = i371141[0]
  i371140.ascent = i371141[1]
  i371140.originalLineHeight = i371141[2]
  i371140.fontSize = i371141[3]
  var i371143 = i371141[4]
  var i371142 = []
  for(var i = 0; i < i371143.length; i += 1) {
    i371142.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Font+CharacterInfo', i371143[i + 0]) );
  }
  i371140.characterInfo = i371142
  request.r(i371141[5], i371141[6], 0, i371140, 'texture')
  i371140.originalFontSize = i371141[7]
  return i371140
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Font+CharacterInfo"] = function (request, data, root) {
  var i371146 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Font+CharacterInfo' )
  var i371147 = data
  i371146.index = i371147[0]
  i371146.advance = i371147[1]
  i371146.bearing = i371147[2]
  i371146.glyphWidth = i371147[3]
  i371146.glyphHeight = i371147[4]
  i371146.minX = i371147[5]
  i371146.maxX = i371147[6]
  i371146.minY = i371147[7]
  i371146.maxY = i371147[8]
  i371146.uvBottomLeftX = i371147[9]
  i371146.uvBottomLeftY = i371147[10]
  i371146.uvBottomRightX = i371147[11]
  i371146.uvBottomRightY = i371147[12]
  i371146.uvTopLeftX = i371147[13]
  i371146.uvTopLeftY = i371147[14]
  i371146.uvTopRightX = i371147[15]
  i371146.uvTopRightY = i371147[16]
  return i371146
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.TextAsset"] = function (request, data, root) {
  var i371148 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.TextAsset' )
  var i371149 = data
  i371148.name = i371149[0]
  i371148.bytes64 = i371149[1]
  i371148.data = i371149[2]
  return i371148
}

Deserializers["DG.Tweening.Core.DOTweenSettings"] = function (request, data, root) {
  var i371150 = root || request.c( 'DG.Tweening.Core.DOTweenSettings' )
  var i371151 = data
  i371150.useSafeMode = !!i371151[0]
  i371150.safeModeOptions = request.d('DG.Tweening.Core.DOTweenSettings+SafeModeOptions', i371151[1], i371150.safeModeOptions)
  i371150.timeScale = i371151[2]
  i371150.unscaledTimeScale = i371151[3]
  i371150.useSmoothDeltaTime = !!i371151[4]
  i371150.maxSmoothUnscaledTime = i371151[5]
  i371150.rewindCallbackMode = i371151[6]
  i371150.showUnityEditorReport = !!i371151[7]
  i371150.logBehaviour = i371151[8]
  i371150.drawGizmos = !!i371151[9]
  i371150.defaultRecyclable = !!i371151[10]
  i371150.defaultAutoPlay = i371151[11]
  i371150.defaultUpdateType = i371151[12]
  i371150.defaultTimeScaleIndependent = !!i371151[13]
  i371150.defaultEaseType = i371151[14]
  i371150.defaultEaseOvershootOrAmplitude = i371151[15]
  i371150.defaultEasePeriod = i371151[16]
  i371150.defaultAutoKill = !!i371151[17]
  i371150.defaultLoopType = i371151[18]
  i371150.debugMode = !!i371151[19]
  i371150.debugStoreTargetId = !!i371151[20]
  i371150.showPreviewPanel = !!i371151[21]
  i371150.storeSettingsLocation = i371151[22]
  i371150.modules = request.d('DG.Tweening.Core.DOTweenSettings+ModulesSetup', i371151[23], i371150.modules)
  i371150.createASMDEF = !!i371151[24]
  i371150.showPlayingTweens = !!i371151[25]
  i371150.showPausedTweens = !!i371151[26]
  return i371150
}

Deserializers["DG.Tweening.Core.DOTweenSettings+SafeModeOptions"] = function (request, data, root) {
  var i371152 = root || request.c( 'DG.Tweening.Core.DOTweenSettings+SafeModeOptions' )
  var i371153 = data
  i371152.logBehaviour = i371153[0]
  i371152.nestedTweenFailureBehaviour = i371153[1]
  return i371152
}

Deserializers["DG.Tweening.Core.DOTweenSettings+ModulesSetup"] = function (request, data, root) {
  var i371154 = root || request.c( 'DG.Tweening.Core.DOTweenSettings+ModulesSetup' )
  var i371155 = data
  i371154.showPanel = !!i371155[0]
  i371154.audioEnabled = !!i371155[1]
  i371154.physicsEnabled = !!i371155[2]
  i371154.physics2DEnabled = !!i371155[3]
  i371154.spriteEnabled = !!i371155[4]
  i371154.uiEnabled = !!i371155[5]
  i371154.textMeshProEnabled = !!i371155[6]
  i371154.tk2DEnabled = !!i371155[7]
  i371154.deAudioEnabled = !!i371155[8]
  i371154.deUnityExtendedEnabled = !!i371155[9]
  i371154.epoOutlineEnabled = !!i371155[10]
  return i371154
}

Deserializers["TMPro.TMP_Settings"] = function (request, data, root) {
  var i371156 = root || request.c( 'TMPro.TMP_Settings' )
  var i371157 = data
  i371156.m_enableWordWrapping = !!i371157[0]
  i371156.m_enableKerning = !!i371157[1]
  i371156.m_enableExtraPadding = !!i371157[2]
  i371156.m_enableTintAllSprites = !!i371157[3]
  i371156.m_enableParseEscapeCharacters = !!i371157[4]
  i371156.m_EnableRaycastTarget = !!i371157[5]
  i371156.m_GetFontFeaturesAtRuntime = !!i371157[6]
  i371156.m_missingGlyphCharacter = i371157[7]
  i371156.m_warningsDisabled = !!i371157[8]
  request.r(i371157[9], i371157[10], 0, i371156, 'm_defaultFontAsset')
  i371156.m_defaultFontAssetPath = i371157[11]
  i371156.m_defaultFontSize = i371157[12]
  i371156.m_defaultAutoSizeMinRatio = i371157[13]
  i371156.m_defaultAutoSizeMaxRatio = i371157[14]
  i371156.m_defaultTextMeshProTextContainerSize = new pc.Vec2( i371157[15], i371157[16] )
  i371156.m_defaultTextMeshProUITextContainerSize = new pc.Vec2( i371157[17], i371157[18] )
  i371156.m_autoSizeTextContainer = !!i371157[19]
  i371156.m_IsTextObjectScaleStatic = !!i371157[20]
  var i371159 = i371157[21]
  var i371158 = new (System.Collections.Generic.List$1(Bridge.ns('TMPro.TMP_FontAsset')))
  for(var i = 0; i < i371159.length; i += 2) {
  request.r(i371159[i + 0], i371159[i + 1], 1, i371158, '')
  }
  i371156.m_fallbackFontAssets = i371158
  i371156.m_matchMaterialPreset = !!i371157[22]
  request.r(i371157[23], i371157[24], 0, i371156, 'm_defaultSpriteAsset')
  i371156.m_defaultSpriteAssetPath = i371157[25]
  i371156.m_enableEmojiSupport = !!i371157[26]
  i371156.m_MissingCharacterSpriteUnicode = i371157[27]
  i371156.m_defaultColorGradientPresetsPath = i371157[28]
  request.r(i371157[29], i371157[30], 0, i371156, 'm_defaultStyleSheet')
  i371156.m_StyleSheetsResourcePath = i371157[31]
  request.r(i371157[32], i371157[33], 0, i371156, 'm_leadingCharacters')
  request.r(i371157[34], i371157[35], 0, i371156, 'm_followingCharacters')
  i371156.m_UseModernHangulLineBreakingRules = !!i371157[36]
  return i371156
}

Deserializers["TMPro.TMP_FontAsset"] = function (request, data, root) {
  var i371162 = root || request.c( 'TMPro.TMP_FontAsset' )
  var i371163 = data
  request.r(i371163[0], i371163[1], 0, i371162, 'atlas')
  i371162.normalStyle = i371163[2]
  i371162.normalSpacingOffset = i371163[3]
  i371162.boldStyle = i371163[4]
  i371162.boldSpacing = i371163[5]
  i371162.italicStyle = i371163[6]
  i371162.tabSize = i371163[7]
  i371162.hashCode = i371163[8]
  request.r(i371163[9], i371163[10], 0, i371162, 'material')
  i371162.materialHashCode = i371163[11]
  i371162.m_Version = i371163[12]
  i371162.m_SourceFontFileGUID = i371163[13]
  request.r(i371163[14], i371163[15], 0, i371162, 'm_SourceFontFile_EditorRef')
  request.r(i371163[16], i371163[17], 0, i371162, 'm_SourceFontFile')
  i371162.m_AtlasPopulationMode = i371163[18]
  i371162.m_FaceInfo = request.d('UnityEngine.TextCore.FaceInfo', i371163[19], i371162.m_FaceInfo)
  var i371165 = i371163[20]
  var i371164 = new (System.Collections.Generic.List$1(Bridge.ns('UnityEngine.TextCore.Glyph')))
  for(var i = 0; i < i371165.length; i += 1) {
    i371164.add(request.d('UnityEngine.TextCore.Glyph', i371165[i + 0]));
  }
  i371162.m_GlyphTable = i371164
  var i371167 = i371163[21]
  var i371166 = new (System.Collections.Generic.List$1(Bridge.ns('TMPro.TMP_Character')))
  for(var i = 0; i < i371167.length; i += 1) {
    i371166.add(request.d('TMPro.TMP_Character', i371167[i + 0]));
  }
  i371162.m_CharacterTable = i371166
  var i371169 = i371163[22]
  var i371168 = []
  for(var i = 0; i < i371169.length; i += 2) {
  request.r(i371169[i + 0], i371169[i + 1], 2, i371168, '')
  }
  i371162.m_AtlasTextures = i371168
  i371162.m_AtlasTextureIndex = i371163[23]
  i371162.m_IsMultiAtlasTexturesEnabled = !!i371163[24]
  i371162.m_ClearDynamicDataOnBuild = !!i371163[25]
  var i371171 = i371163[26]
  var i371170 = new (System.Collections.Generic.List$1(Bridge.ns('UnityEngine.TextCore.GlyphRect')))
  for(var i = 0; i < i371171.length; i += 1) {
    i371170.add(request.d('UnityEngine.TextCore.GlyphRect', i371171[i + 0]));
  }
  i371162.m_UsedGlyphRects = i371170
  var i371173 = i371163[27]
  var i371172 = new (System.Collections.Generic.List$1(Bridge.ns('UnityEngine.TextCore.GlyphRect')))
  for(var i = 0; i < i371173.length; i += 1) {
    i371172.add(request.d('UnityEngine.TextCore.GlyphRect', i371173[i + 0]));
  }
  i371162.m_FreeGlyphRects = i371172
  i371162.m_fontInfo = request.d('TMPro.FaceInfo_Legacy', i371163[28], i371162.m_fontInfo)
  i371162.m_AtlasWidth = i371163[29]
  i371162.m_AtlasHeight = i371163[30]
  i371162.m_AtlasPadding = i371163[31]
  i371162.m_AtlasRenderMode = i371163[32]
  var i371175 = i371163[33]
  var i371174 = new (System.Collections.Generic.List$1(Bridge.ns('TMPro.TMP_Glyph')))
  for(var i = 0; i < i371175.length; i += 1) {
    i371174.add(request.d('TMPro.TMP_Glyph', i371175[i + 0]));
  }
  i371162.m_glyphInfoList = i371174
  i371162.m_KerningTable = request.d('TMPro.KerningTable', i371163[34], i371162.m_KerningTable)
  i371162.m_FontFeatureTable = request.d('TMPro.TMP_FontFeatureTable', i371163[35], i371162.m_FontFeatureTable)
  var i371177 = i371163[36]
  var i371176 = new (System.Collections.Generic.List$1(Bridge.ns('TMPro.TMP_FontAsset')))
  for(var i = 0; i < i371177.length; i += 2) {
  request.r(i371177[i + 0], i371177[i + 1], 1, i371176, '')
  }
  i371162.fallbackFontAssets = i371176
  var i371179 = i371163[37]
  var i371178 = new (System.Collections.Generic.List$1(Bridge.ns('TMPro.TMP_FontAsset')))
  for(var i = 0; i < i371179.length; i += 2) {
  request.r(i371179[i + 0], i371179[i + 1], 1, i371178, '')
  }
  i371162.m_FallbackFontAssetTable = i371178
  i371162.m_CreationSettings = request.d('TMPro.FontAssetCreationSettings', i371163[38], i371162.m_CreationSettings)
  var i371181 = i371163[39]
  var i371180 = []
  for(var i = 0; i < i371181.length; i += 1) {
    i371180.push( request.d('TMPro.TMP_FontWeightPair', i371181[i + 0]) );
  }
  i371162.m_FontWeightTable = i371180
  var i371183 = i371163[40]
  var i371182 = []
  for(var i = 0; i < i371183.length; i += 1) {
    i371182.push( request.d('TMPro.TMP_FontWeightPair', i371183[i + 0]) );
  }
  i371162.fontWeights = i371182
  return i371162
}

Deserializers["UnityEngine.TextCore.FaceInfo"] = function (request, data, root) {
  var i371184 = root || request.c( 'UnityEngine.TextCore.FaceInfo' )
  var i371185 = data
  i371184.m_FaceIndex = i371185[0]
  i371184.m_FamilyName = i371185[1]
  i371184.m_StyleName = i371185[2]
  i371184.m_PointSize = i371185[3]
  i371184.m_Scale = i371185[4]
  i371184.m_UnitsPerEM = i371185[5]
  i371184.m_LineHeight = i371185[6]
  i371184.m_AscentLine = i371185[7]
  i371184.m_CapLine = i371185[8]
  i371184.m_MeanLine = i371185[9]
  i371184.m_Baseline = i371185[10]
  i371184.m_DescentLine = i371185[11]
  i371184.m_SuperscriptOffset = i371185[12]
  i371184.m_SuperscriptSize = i371185[13]
  i371184.m_SubscriptOffset = i371185[14]
  i371184.m_SubscriptSize = i371185[15]
  i371184.m_UnderlineOffset = i371185[16]
  i371184.m_UnderlineThickness = i371185[17]
  i371184.m_StrikethroughOffset = i371185[18]
  i371184.m_StrikethroughThickness = i371185[19]
  i371184.m_TabWidth = i371185[20]
  return i371184
}

Deserializers["UnityEngine.TextCore.Glyph"] = function (request, data, root) {
  var i371188 = root || request.c( 'UnityEngine.TextCore.Glyph' )
  var i371189 = data
  i371188.m_Index = i371189[0]
  i371188.m_Metrics = request.d('UnityEngine.TextCore.GlyphMetrics', i371189[1], i371188.m_Metrics)
  i371188.m_GlyphRect = request.d('UnityEngine.TextCore.GlyphRect', i371189[2], i371188.m_GlyphRect)
  i371188.m_Scale = i371189[3]
  i371188.m_AtlasIndex = i371189[4]
  i371188.m_ClassDefinitionType = i371189[5]
  return i371188
}

Deserializers["UnityEngine.TextCore.GlyphMetrics"] = function (request, data, root) {
  var i371190 = root || request.c( 'UnityEngine.TextCore.GlyphMetrics' )
  var i371191 = data
  i371190.m_Width = i371191[0]
  i371190.m_Height = i371191[1]
  i371190.m_HorizontalBearingX = i371191[2]
  i371190.m_HorizontalBearingY = i371191[3]
  i371190.m_HorizontalAdvance = i371191[4]
  return i371190
}

Deserializers["UnityEngine.TextCore.GlyphRect"] = function (request, data, root) {
  var i371192 = root || request.c( 'UnityEngine.TextCore.GlyphRect' )
  var i371193 = data
  i371192.m_X = i371193[0]
  i371192.m_Y = i371193[1]
  i371192.m_Width = i371193[2]
  i371192.m_Height = i371193[3]
  return i371192
}

Deserializers["TMPro.TMP_Character"] = function (request, data, root) {
  var i371196 = root || request.c( 'TMPro.TMP_Character' )
  var i371197 = data
  i371196.m_ElementType = i371197[0]
  i371196.m_Unicode = i371197[1]
  i371196.m_GlyphIndex = i371197[2]
  i371196.m_Scale = i371197[3]
  return i371196
}

Deserializers["TMPro.FaceInfo_Legacy"] = function (request, data, root) {
  var i371202 = root || request.c( 'TMPro.FaceInfo_Legacy' )
  var i371203 = data
  i371202.Name = i371203[0]
  i371202.PointSize = i371203[1]
  i371202.Scale = i371203[2]
  i371202.CharacterCount = i371203[3]
  i371202.LineHeight = i371203[4]
  i371202.Baseline = i371203[5]
  i371202.Ascender = i371203[6]
  i371202.CapHeight = i371203[7]
  i371202.Descender = i371203[8]
  i371202.CenterLine = i371203[9]
  i371202.SuperscriptOffset = i371203[10]
  i371202.SubscriptOffset = i371203[11]
  i371202.SubSize = i371203[12]
  i371202.Underline = i371203[13]
  i371202.UnderlineThickness = i371203[14]
  i371202.strikethrough = i371203[15]
  i371202.strikethroughThickness = i371203[16]
  i371202.TabWidth = i371203[17]
  i371202.Padding = i371203[18]
  i371202.AtlasWidth = i371203[19]
  i371202.AtlasHeight = i371203[20]
  return i371202
}

Deserializers["TMPro.TMP_Glyph"] = function (request, data, root) {
  var i371206 = root || request.c( 'TMPro.TMP_Glyph' )
  var i371207 = data
  i371206.id = i371207[0]
  i371206.x = i371207[1]
  i371206.y = i371207[2]
  i371206.width = i371207[3]
  i371206.height = i371207[4]
  i371206.xOffset = i371207[5]
  i371206.yOffset = i371207[6]
  i371206.xAdvance = i371207[7]
  i371206.scale = i371207[8]
  return i371206
}

Deserializers["TMPro.KerningTable"] = function (request, data, root) {
  var i371208 = root || request.c( 'TMPro.KerningTable' )
  var i371209 = data
  var i371211 = i371209[0]
  var i371210 = new (System.Collections.Generic.List$1(Bridge.ns('TMPro.KerningPair')))
  for(var i = 0; i < i371211.length; i += 1) {
    i371210.add(request.d('TMPro.KerningPair', i371211[i + 0]));
  }
  i371208.kerningPairs = i371210
  return i371208
}

Deserializers["TMPro.KerningPair"] = function (request, data, root) {
  var i371214 = root || request.c( 'TMPro.KerningPair' )
  var i371215 = data
  i371214.xOffset = i371215[0]
  i371214.m_FirstGlyph = i371215[1]
  i371214.m_FirstGlyphAdjustments = request.d('TMPro.GlyphValueRecord_Legacy', i371215[2], i371214.m_FirstGlyphAdjustments)
  i371214.m_SecondGlyph = i371215[3]
  i371214.m_SecondGlyphAdjustments = request.d('TMPro.GlyphValueRecord_Legacy', i371215[4], i371214.m_SecondGlyphAdjustments)
  i371214.m_IgnoreSpacingAdjustments = !!i371215[5]
  return i371214
}

Deserializers["TMPro.TMP_FontFeatureTable"] = function (request, data, root) {
  var i371216 = root || request.c( 'TMPro.TMP_FontFeatureTable' )
  var i371217 = data
  var i371219 = i371217[0]
  var i371218 = new (System.Collections.Generic.List$1(Bridge.ns('TMPro.TMP_GlyphPairAdjustmentRecord')))
  for(var i = 0; i < i371219.length; i += 1) {
    i371218.add(request.d('TMPro.TMP_GlyphPairAdjustmentRecord', i371219[i + 0]));
  }
  i371216.m_GlyphPairAdjustmentRecords = i371218
  return i371216
}

Deserializers["TMPro.TMP_GlyphPairAdjustmentRecord"] = function (request, data, root) {
  var i371222 = root || request.c( 'TMPro.TMP_GlyphPairAdjustmentRecord' )
  var i371223 = data
  i371222.m_FirstAdjustmentRecord = request.d('TMPro.TMP_GlyphAdjustmentRecord', i371223[0], i371222.m_FirstAdjustmentRecord)
  i371222.m_SecondAdjustmentRecord = request.d('TMPro.TMP_GlyphAdjustmentRecord', i371223[1], i371222.m_SecondAdjustmentRecord)
  i371222.m_FeatureLookupFlags = i371223[2]
  return i371222
}

Deserializers["TMPro.TMP_GlyphAdjustmentRecord"] = function (request, data, root) {
  var i371224 = root || request.c( 'TMPro.TMP_GlyphAdjustmentRecord' )
  var i371225 = data
  i371224.m_GlyphIndex = i371225[0]
  i371224.m_GlyphValueRecord = request.d('TMPro.TMP_GlyphValueRecord', i371225[1], i371224.m_GlyphValueRecord)
  return i371224
}

Deserializers["TMPro.TMP_GlyphValueRecord"] = function (request, data, root) {
  var i371226 = root || request.c( 'TMPro.TMP_GlyphValueRecord' )
  var i371227 = data
  i371226.m_XPlacement = i371227[0]
  i371226.m_YPlacement = i371227[1]
  i371226.m_XAdvance = i371227[2]
  i371226.m_YAdvance = i371227[3]
  return i371226
}

Deserializers["TMPro.FontAssetCreationSettings"] = function (request, data, root) {
  var i371228 = root || request.c( 'TMPro.FontAssetCreationSettings' )
  var i371229 = data
  i371228.sourceFontFileName = i371229[0]
  i371228.sourceFontFileGUID = i371229[1]
  i371228.pointSizeSamplingMode = i371229[2]
  i371228.pointSize = i371229[3]
  i371228.padding = i371229[4]
  i371228.packingMode = i371229[5]
  i371228.atlasWidth = i371229[6]
  i371228.atlasHeight = i371229[7]
  i371228.characterSetSelectionMode = i371229[8]
  i371228.characterSequence = i371229[9]
  i371228.referencedFontAssetGUID = i371229[10]
  i371228.referencedTextAssetGUID = i371229[11]
  i371228.fontStyle = i371229[12]
  i371228.fontStyleModifier = i371229[13]
  i371228.renderMode = i371229[14]
  i371228.includeFontFeatures = !!i371229[15]
  return i371228
}

Deserializers["TMPro.TMP_FontWeightPair"] = function (request, data, root) {
  var i371232 = root || request.c( 'TMPro.TMP_FontWeightPair' )
  var i371233 = data
  request.r(i371233[0], i371233[1], 0, i371232, 'regularTypeface')
  request.r(i371233[2], i371233[3], 0, i371232, 'italicTypeface')
  return i371232
}

Deserializers["TMPro.TMP_SpriteAsset"] = function (request, data, root) {
  var i371234 = root || request.c( 'TMPro.TMP_SpriteAsset' )
  var i371235 = data
  request.r(i371235[0], i371235[1], 0, i371234, 'spriteSheet')
  var i371237 = i371235[2]
  var i371236 = new (System.Collections.Generic.List$1(Bridge.ns('TMPro.TMP_Sprite')))
  for(var i = 0; i < i371237.length; i += 1) {
    i371236.add(request.d('TMPro.TMP_Sprite', i371237[i + 0]));
  }
  i371234.spriteInfoList = i371236
  var i371239 = i371235[3]
  var i371238 = new (System.Collections.Generic.List$1(Bridge.ns('TMPro.TMP_SpriteAsset')))
  for(var i = 0; i < i371239.length; i += 2) {
  request.r(i371239[i + 0], i371239[i + 1], 1, i371238, '')
  }
  i371234.fallbackSpriteAssets = i371238
  i371234.hashCode = i371235[4]
  request.r(i371235[5], i371235[6], 0, i371234, 'material')
  i371234.materialHashCode = i371235[7]
  i371234.m_Version = i371235[8]
  i371234.m_FaceInfo = request.d('UnityEngine.TextCore.FaceInfo', i371235[9], i371234.m_FaceInfo)
  var i371241 = i371235[10]
  var i371240 = new (System.Collections.Generic.List$1(Bridge.ns('TMPro.TMP_SpriteCharacter')))
  for(var i = 0; i < i371241.length; i += 1) {
    i371240.add(request.d('TMPro.TMP_SpriteCharacter', i371241[i + 0]));
  }
  i371234.m_SpriteCharacterTable = i371240
  var i371243 = i371235[11]
  var i371242 = new (System.Collections.Generic.List$1(Bridge.ns('TMPro.TMP_SpriteGlyph')))
  for(var i = 0; i < i371243.length; i += 1) {
    i371242.add(request.d('TMPro.TMP_SpriteGlyph', i371243[i + 0]));
  }
  i371234.m_SpriteGlyphTable = i371242
  return i371234
}

Deserializers["TMPro.TMP_Sprite"] = function (request, data, root) {
  var i371246 = root || request.c( 'TMPro.TMP_Sprite' )
  var i371247 = data
  i371246.name = i371247[0]
  i371246.hashCode = i371247[1]
  i371246.unicode = i371247[2]
  i371246.pivot = new pc.Vec2( i371247[3], i371247[4] )
  request.r(i371247[5], i371247[6], 0, i371246, 'sprite')
  i371246.id = i371247[7]
  i371246.x = i371247[8]
  i371246.y = i371247[9]
  i371246.width = i371247[10]
  i371246.height = i371247[11]
  i371246.xOffset = i371247[12]
  i371246.yOffset = i371247[13]
  i371246.xAdvance = i371247[14]
  i371246.scale = i371247[15]
  return i371246
}

Deserializers["TMPro.TMP_SpriteCharacter"] = function (request, data, root) {
  var i371252 = root || request.c( 'TMPro.TMP_SpriteCharacter' )
  var i371253 = data
  i371252.m_Name = i371253[0]
  i371252.m_HashCode = i371253[1]
  i371252.m_ElementType = i371253[2]
  i371252.m_Unicode = i371253[3]
  i371252.m_GlyphIndex = i371253[4]
  i371252.m_Scale = i371253[5]
  return i371252
}

Deserializers["TMPro.TMP_SpriteGlyph"] = function (request, data, root) {
  var i371256 = root || request.c( 'TMPro.TMP_SpriteGlyph' )
  var i371257 = data
  request.r(i371257[0], i371257[1], 0, i371256, 'sprite')
  i371256.m_Index = i371257[2]
  i371256.m_Metrics = request.d('UnityEngine.TextCore.GlyphMetrics', i371257[3], i371256.m_Metrics)
  i371256.m_GlyphRect = request.d('UnityEngine.TextCore.GlyphRect', i371257[4], i371256.m_GlyphRect)
  i371256.m_Scale = i371257[5]
  i371256.m_AtlasIndex = i371257[6]
  i371256.m_ClassDefinitionType = i371257[7]
  return i371256
}

Deserializers["TMPro.TMP_StyleSheet"] = function (request, data, root) {
  var i371258 = root || request.c( 'TMPro.TMP_StyleSheet' )
  var i371259 = data
  var i371261 = i371259[0]
  var i371260 = new (System.Collections.Generic.List$1(Bridge.ns('TMPro.TMP_Style')))
  for(var i = 0; i < i371261.length; i += 1) {
    i371260.add(request.d('TMPro.TMP_Style', i371261[i + 0]));
  }
  i371258.m_StyleList = i371260
  return i371258
}

Deserializers["TMPro.TMP_Style"] = function (request, data, root) {
  var i371264 = root || request.c( 'TMPro.TMP_Style' )
  var i371265 = data
  i371264.m_Name = i371265[0]
  i371264.m_HashCode = i371265[1]
  i371264.m_OpeningDefinition = i371265[2]
  i371264.m_ClosingDefinition = i371265[3]
  i371264.m_OpeningTagArray = i371265[4]
  i371264.m_ClosingTagArray = i371265[5]
  i371264.m_OpeningTagUnicodeArray = i371265[6]
  i371264.m_ClosingTagUnicodeArray = i371265[7]
  return i371264
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Resources"] = function (request, data, root) {
  var i371266 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Resources' )
  var i371267 = data
  var i371269 = i371267[0]
  var i371268 = []
  for(var i = 0; i < i371269.length; i += 1) {
    i371268.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.Resources+File', i371269[i + 0]) );
  }
  i371266.files = i371268
  i371266.componentToPrefabIds = i371267[1]
  return i371266
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Resources+File"] = function (request, data, root) {
  var i371272 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Resources+File' )
  var i371273 = data
  i371272.path = i371273[0]
  request.r(i371273[1], i371273[2], 0, i371272, 'unityObject')
  return i371272
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings"] = function (request, data, root) {
  var i371274 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings' )
  var i371275 = data
  var i371277 = i371275[0]
  var i371276 = []
  for(var i = 0; i < i371277.length; i += 1) {
    i371276.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+ScriptsExecutionOrder', i371277[i + 0]) );
  }
  i371274.scriptsExecutionOrder = i371276
  var i371279 = i371275[1]
  var i371278 = []
  for(var i = 0; i < i371279.length; i += 1) {
    i371278.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+SortingLayer', i371279[i + 0]) );
  }
  i371274.sortingLayers = i371278
  var i371281 = i371275[2]
  var i371280 = []
  for(var i = 0; i < i371281.length; i += 1) {
    i371280.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+CullingLayer', i371281[i + 0]) );
  }
  i371274.cullingLayers = i371280
  i371274.timeSettings = request.d('Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+TimeSettings', i371275[3], i371274.timeSettings)
  i371274.physicsSettings = request.d('Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+PhysicsSettings', i371275[4], i371274.physicsSettings)
  i371274.physics2DSettings = request.d('Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+Physics2DSettings', i371275[5], i371274.physics2DSettings)
  i371274.qualitySettings = request.d('Luna.Unity.DTO.UnityEngine.Assets.QualitySettings', i371275[6], i371274.qualitySettings)
  i371274.enableRealtimeShadows = !!i371275[7]
  i371274.enableAutoInstancing = !!i371275[8]
  i371274.enableStaticBatching = !!i371275[9]
  i371274.enableDynamicBatching = !!i371275[10]
  i371274.lightmapEncodingQuality = i371275[11]
  i371274.desiredColorSpace = i371275[12]
  var i371283 = i371275[13]
  var i371282 = []
  for(var i = 0; i < i371283.length; i += 1) {
    i371282.push( i371283[i + 0] );
  }
  i371274.allTags = i371282
  return i371274
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+ScriptsExecutionOrder"] = function (request, data, root) {
  var i371286 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+ScriptsExecutionOrder' )
  var i371287 = data
  i371286.name = i371287[0]
  i371286.value = i371287[1]
  return i371286
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+SortingLayer"] = function (request, data, root) {
  var i371290 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+SortingLayer' )
  var i371291 = data
  i371290.id = i371291[0]
  i371290.name = i371291[1]
  i371290.value = i371291[2]
  return i371290
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+CullingLayer"] = function (request, data, root) {
  var i371294 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+CullingLayer' )
  var i371295 = data
  i371294.id = i371295[0]
  i371294.name = i371295[1]
  return i371294
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+TimeSettings"] = function (request, data, root) {
  var i371296 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+TimeSettings' )
  var i371297 = data
  i371296.fixedDeltaTime = i371297[0]
  i371296.maximumDeltaTime = i371297[1]
  i371296.timeScale = i371297[2]
  i371296.maximumParticleTimestep = i371297[3]
  return i371296
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+PhysicsSettings"] = function (request, data, root) {
  var i371298 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+PhysicsSettings' )
  var i371299 = data
  i371298.gravity = new pc.Vec3( i371299[0], i371299[1], i371299[2] )
  i371298.defaultSolverIterations = i371299[3]
  i371298.bounceThreshold = i371299[4]
  i371298.autoSyncTransforms = !!i371299[5]
  i371298.autoSimulation = !!i371299[6]
  var i371301 = i371299[7]
  var i371300 = []
  for(var i = 0; i < i371301.length; i += 1) {
    i371300.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+PhysicsSettings+CollisionMask', i371301[i + 0]) );
  }
  i371298.collisionMatrix = i371300
  return i371298
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+PhysicsSettings+CollisionMask"] = function (request, data, root) {
  var i371304 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+PhysicsSettings+CollisionMask' )
  var i371305 = data
  i371304.enabled = !!i371305[0]
  i371304.layerId = i371305[1]
  i371304.otherLayerId = i371305[2]
  return i371304
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+Physics2DSettings"] = function (request, data, root) {
  var i371306 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+Physics2DSettings' )
  var i371307 = data
  request.r(i371307[0], i371307[1], 0, i371306, 'material')
  i371306.gravity = new pc.Vec2( i371307[2], i371307[3] )
  i371306.positionIterations = i371307[4]
  i371306.velocityIterations = i371307[5]
  i371306.velocityThreshold = i371307[6]
  i371306.maxLinearCorrection = i371307[7]
  i371306.maxAngularCorrection = i371307[8]
  i371306.maxTranslationSpeed = i371307[9]
  i371306.maxRotationSpeed = i371307[10]
  i371306.baumgarteScale = i371307[11]
  i371306.baumgarteTOIScale = i371307[12]
  i371306.timeToSleep = i371307[13]
  i371306.linearSleepTolerance = i371307[14]
  i371306.angularSleepTolerance = i371307[15]
  i371306.defaultContactOffset = i371307[16]
  i371306.autoSimulation = !!i371307[17]
  i371306.queriesHitTriggers = !!i371307[18]
  i371306.queriesStartInColliders = !!i371307[19]
  i371306.callbacksOnDisable = !!i371307[20]
  i371306.reuseCollisionCallbacks = !!i371307[21]
  i371306.autoSyncTransforms = !!i371307[22]
  var i371309 = i371307[23]
  var i371308 = []
  for(var i = 0; i < i371309.length; i += 1) {
    i371308.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+Physics2DSettings+CollisionMask', i371309[i + 0]) );
  }
  i371306.collisionMatrix = i371308
  return i371306
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+Physics2DSettings+CollisionMask"] = function (request, data, root) {
  var i371312 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+Physics2DSettings+CollisionMask' )
  var i371313 = data
  i371312.enabled = !!i371313[0]
  i371312.layerId = i371313[1]
  i371312.otherLayerId = i371313[2]
  return i371312
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.QualitySettings"] = function (request, data, root) {
  var i371314 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.QualitySettings' )
  var i371315 = data
  var i371317 = i371315[0]
  var i371316 = []
  for(var i = 0; i < i371317.length; i += 1) {
    i371316.push( request.d('Luna.Unity.DTO.UnityEngine.Assets.QualitySettings', i371317[i + 0]) );
  }
  i371314.qualityLevels = i371316
  var i371319 = i371315[1]
  var i371318 = []
  for(var i = 0; i < i371319.length; i += 1) {
    i371318.push( i371319[i + 0] );
  }
  i371314.names = i371318
  i371314.shadows = i371315[2]
  i371314.anisotropicFiltering = i371315[3]
  i371314.antiAliasing = i371315[4]
  i371314.lodBias = i371315[5]
  i371314.shadowCascades = i371315[6]
  i371314.shadowDistance = i371315[7]
  i371314.shadowmaskMode = i371315[8]
  i371314.shadowProjection = i371315[9]
  i371314.shadowResolution = i371315[10]
  i371314.softParticles = !!i371315[11]
  i371314.softVegetation = !!i371315[12]
  i371314.activeColorSpace = i371315[13]
  i371314.desiredColorSpace = i371315[14]
  i371314.masterTextureLimit = i371315[15]
  i371314.maxQueuedFrames = i371315[16]
  i371314.particleRaycastBudget = i371315[17]
  i371314.pixelLightCount = i371315[18]
  i371314.realtimeReflectionProbes = !!i371315[19]
  i371314.shadowCascade2Split = i371315[20]
  i371314.shadowCascade4Split = new pc.Vec3( i371315[21], i371315[22], i371315[23] )
  i371314.streamingMipmapsActive = !!i371315[24]
  i371314.vSyncCount = i371315[25]
  i371314.asyncUploadBufferSize = i371315[26]
  i371314.asyncUploadTimeSlice = i371315[27]
  i371314.billboardsFaceCameraPosition = !!i371315[28]
  i371314.shadowNearPlaneOffset = i371315[29]
  i371314.streamingMipmapsMemoryBudget = i371315[30]
  i371314.maximumLODLevel = i371315[31]
  i371314.streamingMipmapsAddAllCameras = !!i371315[32]
  i371314.streamingMipmapsMaxLevelReduction = i371315[33]
  i371314.streamingMipmapsRenderersPerFrame = i371315[34]
  i371314.resolutionScalingFixedDPIFactor = i371315[35]
  i371314.streamingMipmapsMaxFileIORequests = i371315[36]
  i371314.currentQualityLevel = i371315[37]
  return i371314
}

Deserializers["Luna.Unity.DTO.UnityEngine.Assets.Mesh+BlendShapeFrame"] = function (request, data, root) {
  var i371324 = root || request.c( 'Luna.Unity.DTO.UnityEngine.Assets.Mesh+BlendShapeFrame' )
  var i371325 = data
  i371324.weight = i371325[0]
  i371324.vertices = i371325[1]
  i371324.normals = i371325[2]
  i371324.tangents = i371325[3]
  return i371324
}

Deserializers["TMPro.GlyphValueRecord_Legacy"] = function (request, data, root) {
  var i371326 = root || request.c( 'TMPro.GlyphValueRecord_Legacy' )
  var i371327 = data
  i371326.xPlacement = i371327[0]
  i371326.yPlacement = i371327[1]
  i371326.xAdvance = i371327[2]
  i371326.yAdvance = i371327[3]
  return i371326
}

Deserializers.fields = {"Luna.Unity.DTO.UnityEngine.Textures.Texture2D":{"name":0,"width":1,"height":2,"mipmapCount":3,"anisoLevel":4,"filterMode":5,"hdr":6,"format":7,"wrapMode":8,"alphaIsTransparency":9,"alphaSource":10,"graphicsFormat":11,"sRGBTexture":12,"desiredColorSpace":13,"wrapU":14,"wrapV":15},"Luna.Unity.DTO.UnityEngine.Components.Transform":{"position":0,"scale":3,"rotation":6},"Luna.Unity.DTO.UnityEngine.Scene.GameObject":{"name":0,"tagId":1,"enabled":2,"isStatic":3,"layer":4},"Luna.Unity.DTO.UnityEngine.Components.MeshFilter":{"sharedMesh":0},"Luna.Unity.DTO.UnityEngine.Components.MeshRenderer":{"additionalVertexStreams":0,"enabled":2,"sharedMaterial":3,"sharedMaterials":5,"receiveShadows":6,"shadowCastingMode":7,"sortingLayerID":8,"sortingOrder":9,"lightmapIndex":10,"lightmapSceneIndex":11,"lightmapScaleOffset":12,"lightProbeUsage":16,"reflectionProbeUsage":17},"Luna.Unity.DTO.UnityEngine.Components.SkinnedMeshRenderer":{"sharedMesh":0,"bones":2,"updateWhenOffscreen":3,"localBounds":4,"rootBone":5,"blendShapesWeights":7,"enabled":8,"sharedMaterial":9,"sharedMaterials":11,"receiveShadows":12,"shadowCastingMode":13,"sortingLayerID":14,"sortingOrder":15,"lightmapIndex":16,"lightmapSceneIndex":17,"lightmapScaleOffset":18,"lightProbeUsage":22,"reflectionProbeUsage":23},"Luna.Unity.DTO.UnityEngine.Components.SkinnedMeshRenderer+BlendShapeWeight":{"weight":0},"Luna.Unity.DTO.UnityEngine.Assets.Mesh":{"name":0,"halfPrecision":1,"useUInt32IndexFormat":2,"vertexCount":3,"aabb":4,"streams":5,"vertices":6,"subMeshes":7,"bindposes":8,"blendShapes":9},"Luna.Unity.DTO.UnityEngine.Assets.Mesh+SubMesh":{"triangles":0},"Luna.Unity.DTO.UnityEngine.Assets.Mesh+BlendShape":{"name":0,"frames":1},"Luna.Unity.DTO.UnityEngine.Assets.Material":{"name":0,"shader":1,"renderQueue":3,"enableInstancing":4,"floatParameters":5,"colorParameters":6,"vectorParameters":7,"textureParameters":8,"materialFlags":9},"Luna.Unity.DTO.UnityEngine.Assets.Material+FloatParameter":{"name":0,"value":1},"Luna.Unity.DTO.UnityEngine.Assets.Material+ColorParameter":{"name":0,"value":1},"Luna.Unity.DTO.UnityEngine.Assets.Material+VectorParameter":{"name":0,"value":1},"Luna.Unity.DTO.UnityEngine.Assets.Material+TextureParameter":{"name":0,"value":1},"Luna.Unity.DTO.UnityEngine.Assets.Material+MaterialFlag":{"name":0,"enabled":1},"Luna.Unity.DTO.UnityEngine.Components.CapsuleCollider":{"center":0,"radius":3,"height":4,"direction":5,"enabled":6,"isTrigger":7,"material":8},"Luna.Unity.DTO.UnityEngine.Components.SpriteRenderer":{"color":0,"sprite":4,"flipX":6,"flipY":7,"drawMode":8,"size":9,"tileMode":11,"adaptiveModeThreshold":12,"maskInteraction":13,"spriteSortPoint":14,"enabled":15,"sharedMaterial":16,"sharedMaterials":18,"receiveShadows":19,"shadowCastingMode":20,"sortingLayerID":21,"sortingOrder":22,"lightmapIndex":23,"lightmapSceneIndex":24,"lightmapScaleOffset":25,"lightProbeUsage":29,"reflectionProbeUsage":30},"Luna.Unity.DTO.UnityEngine.Components.Animator":{"animatorController":0,"avatar":2,"updateMode":4,"hasTransformHierarchy":5,"applyRootMotion":6,"humanBones":7,"enabled":8},"Luna.Unity.DTO.UnityEngine.Textures.Cubemap":{"name":0,"atlasId":1,"mipmapCount":2,"hdr":3,"size":4,"anisoLevel":5,"filterMode":6,"rects":7,"wrapU":8,"wrapV":9},"Luna.Unity.DTO.UnityEngine.Scene.Scene":{"name":0,"index":1,"startup":2},"Luna.Unity.DTO.UnityEngine.Components.Rigidbody":{"mass":0,"drag":1,"angularDrag":2,"useGravity":3,"isKinematic":4,"constraints":5,"maxAngularVelocity":6,"collisionDetectionMode":7,"interpolation":8},"Luna.Unity.DTO.UnityEngine.Components.BoxCollider":{"center":0,"size":3,"enabled":6,"isTrigger":7,"material":8},"Luna.Unity.DTO.UnityEngine.Components.RectTransform":{"pivot":0,"anchorMin":2,"anchorMax":4,"sizeDelta":6,"anchoredPosition3D":8,"rotation":11,"scale":15},"Luna.Unity.DTO.UnityEngine.Components.Canvas":{"planeDistance":0,"referencePixelsPerUnit":1,"isFallbackOverlay":2,"renderMode":3,"renderOrder":4,"sortingLayerName":5,"sortingOrder":6,"scaleFactor":7,"worldCamera":8,"overrideSorting":10,"pixelPerfect":11,"targetDisplay":12,"overridePixelPerfect":13,"enabled":14},"Luna.Unity.DTO.UnityEngine.Components.CanvasRenderer":{"cullTransparentMesh":0},"Luna.Unity.DTO.UnityEngine.Components.AudioSource":{"clip":0,"outputAudioMixerGroup":2,"playOnAwake":4,"loop":5,"time":6,"volume":7,"pitch":8,"enabled":9},"Luna.Unity.DTO.UnityEngine.Components.Camera":{"aspect":0,"orthographic":1,"orthographicSize":2,"backgroundColor":3,"nearClipPlane":7,"farClipPlane":8,"fieldOfView":9,"depth":10,"clearFlags":11,"cullingMask":12,"rect":13,"targetTexture":14,"usePhysicalProperties":16,"focalLength":17,"sensorSize":18,"lensShift":20,"gateFit":22,"commandBufferCount":23,"cameraType":24,"enabled":25},"Luna.Unity.DTO.UnityEngine.Components.Light":{"type":0,"color":1,"cullingMask":5,"intensity":6,"range":7,"spotAngle":8,"shadows":9,"shadowNormalBias":10,"shadowBias":11,"shadowStrength":12,"shadowResolution":13,"lightmapBakeType":14,"renderMode":15,"cookie":16,"cookieSize":18,"enabled":19},"Luna.Unity.DTO.UnityEngine.Components.CanvasGroup":{"m_Alpha":0,"m_Interactable":1,"m_BlocksRaycasts":2,"m_IgnoreParentGroups":3,"enabled":4},"Luna.Unity.DTO.UnityEngine.Components.SphereCollider":{"center":0,"radius":3,"enabled":4,"isTrigger":5,"material":6},"Luna.Unity.DTO.UnityEngine.Assets.RenderSettings":{"ambientIntensity":0,"reflectionIntensity":1,"ambientMode":2,"ambientLight":3,"ambientSkyColor":7,"ambientGroundColor":11,"ambientEquatorColor":15,"fogColor":19,"fogEndDistance":23,"fogStartDistance":24,"fogDensity":25,"fog":26,"skybox":27,"fogMode":29,"lightmaps":30,"lightProbes":31,"lightmapsMode":32,"mixedBakeMode":33,"environmentLightingMode":34,"ambientProbe":35,"referenceAmbientProbe":36,"useReferenceAmbientProbe":37,"customReflection":38,"defaultReflection":40,"defaultReflectionMode":42,"defaultReflectionResolution":43,"sunLightObjectId":44,"pixelLightCount":45,"defaultReflectionHDR":46,"hasLightDataAsset":47,"hasManualGenerate":48},"Luna.Unity.DTO.UnityEngine.Assets.RenderSettings+Lightmap":{"lightmapColor":0,"lightmapDirection":2},"Luna.Unity.DTO.UnityEngine.Assets.RenderSettings+LightProbes":{"bakedProbes":0,"positions":1,"hullRays":2,"tetrahedra":3,"neighbours":4,"matrices":5},"Luna.Unity.DTO.UnityEngine.Assets.UniversalRenderPipelineAsset":{"AdditionalLightsPerObjectLimit":0,"AdditionalLightsRenderingMode":1,"LightRenderingMode":2,"ColorGradingLutSize":3,"ColorGradingMode":4,"MainLightRenderingMode":5,"MainLightRenderingModeValue":6,"SupportsMainLightShadows":7,"MixedLightingSupported":8,"MsaaQuality":9,"MSAA":10,"OpaqueDownsampling":11,"MainLightShadowmapResolution":12,"MainLightShadowmapResolutionValue":13,"SupportsSoftShadows":14,"SoftShadowQuality":15,"SoftShadowQualityValue":16,"ShadowDistance":17,"ShadowCascadeCount":18,"Cascade2Split":19,"Cascade3Split":20,"Cascade4Split":22,"CascadeBorder":25,"ShadowDepthBias":26,"ShadowNormalBias":27,"RenderScale":28,"RequireDepthTexture":29,"RequireOpaqueTexture":30,"SupportsHDR":31,"SupportsTerrainHoles":32},"Luna.Unity.DTO.UnityEngine.Assets.LightRenderingMode":{"Disabled":0,"PerVertex":1,"PerPixel":2},"Luna.Unity.DTO.UnityEngine.Assets.ColorGradingMode":{"LowDynamicRange":0,"HighDynamicRange":1},"Luna.Unity.DTO.UnityEngine.Assets.MsaaQuality":{"Disabled":0,"_2x":1,"_4x":2,"_8x":3},"Luna.Unity.DTO.UnityEngine.Assets.Downsampling":{"None":0,"_2xBilinear":1,"_4xBox":2,"_4xBilinear":3},"Luna.Unity.DTO.UnityEngine.Assets.ShadowResolution":{"_256":0,"_512":1,"_1024":2,"_2048":3,"_4096":4},"Luna.Unity.DTO.UnityEngine.Assets.SoftShadowQuality":{"UsePipelineSettings":0,"Low":1,"Medium":2,"High":3},"Luna.Unity.DTO.UnityEngine.Assets.Shader":{"ShaderCompilationErrors":0,"name":1,"guid":2,"shaderDefinedKeywords":3,"passes":4,"usePasses":5,"defaultParameterValues":6,"unityFallbackShader":7,"readDepth":9,"isCreatedByShaderGraph":10,"disableBatching":11,"compiled":12},"Luna.Unity.DTO.UnityEngine.Assets.Shader+ShaderCompilationError":{"shaderName":0,"errorMessage":1},"Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass":{"id":0,"subShaderIndex":1,"name":2,"passType":3,"grabPassTextureName":4,"usePass":5,"zTest":6,"zWrite":7,"culling":8,"blending":9,"alphaBlending":10,"colorWriteMask":11,"offsetUnits":12,"offsetFactor":13,"stencilRef":14,"stencilReadMask":15,"stencilWriteMask":16,"stencilOp":17,"stencilOpFront":18,"stencilOpBack":19,"tags":20,"passDefinedKeywords":21,"passDefinedKeywordGroups":22,"variants":23,"excludedVariants":24,"hasDepthReader":25},"Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Value":{"val":0,"name":1},"Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Blending":{"src":0,"dst":1,"op":2},"Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+StencilOp":{"pass":0,"fail":1,"zFail":2,"comp":3},"Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Tag":{"name":0,"value":1},"Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+KeywordGroup":{"keywords":0,"hasDiscard":1},"Luna.Unity.DTO.UnityEngine.Assets.Shader+Pass+Variant":{"passId":0,"subShaderIndex":1,"keywords":2,"vertexProgram":3,"fragmentProgram":4,"exportedForWebGl2":5,"readDepth":6},"Luna.Unity.DTO.UnityEngine.Assets.Shader+UsePass":{"shader":0,"pass":2},"Luna.Unity.DTO.UnityEngine.Assets.Shader+DefaultParameterValue":{"name":0,"type":1,"value":2,"textureValue":6,"shaderPropertyFlag":7},"Luna.Unity.DTO.UnityEngine.Textures.Sprite":{"name":0,"texture":1,"aabb":3,"vertices":4,"triangles":5,"textureRect":6,"packedRect":10,"border":14,"transparency":18,"bounds":19,"pixelsPerUnit":20,"textureWidth":21,"textureHeight":22,"nativeSize":23,"pivot":25,"textureRectOffset":27},"Luna.Unity.DTO.UnityEngine.Animation.Data.AnimationClip":{"name":0,"wrapMode":1,"isLooping":2,"length":3,"curves":4,"events":5,"halfPrecision":6,"_frameRate":7,"localBounds":8,"hasMuscleCurves":9,"clipMuscleConstant":10,"clipBindingConstant":11},"Luna.Unity.DTO.UnityEngine.Animation.Data.AnimationCurve":{"path":0,"hash":1,"componentType":2,"property":3,"keys":4,"objectReferenceKeys":5},"Luna.Unity.DTO.UnityEngine.Animation.Data.AnimationCurve+ObjectReferenceKey":{"time":0,"value":1},"Luna.Unity.DTO.UnityEngine.Animation.Data.AnimationEvent":{"functionName":0,"floatParameter":1,"intParameter":2,"stringParameter":3,"objectReferenceParameter":4,"time":6},"Luna.Unity.DTO.UnityEngine.Animation.Data.Bounds":{"center":0,"extends":3},"Luna.Unity.DTO.UnityEngine.Animation.Data.AnimationClip+AnimationClipBindingConstant":{"genericBindings":0,"pptrCurveMapping":1},"Luna.Unity.DTO.UnityEngine.Assets.Font":{"name":0,"ascent":1,"originalLineHeight":2,"fontSize":3,"characterInfo":4,"texture":5,"originalFontSize":7},"Luna.Unity.DTO.UnityEngine.Assets.Font+CharacterInfo":{"index":0,"advance":1,"bearing":2,"glyphWidth":3,"glyphHeight":4,"minX":5,"maxX":6,"minY":7,"maxY":8,"uvBottomLeftX":9,"uvBottomLeftY":10,"uvBottomRightX":11,"uvBottomRightY":12,"uvTopLeftX":13,"uvTopLeftY":14,"uvTopRightX":15,"uvTopRightY":16},"Luna.Unity.DTO.UnityEngine.Animation.Mecanim.AnimatorController":{"name":0,"layers":1,"parameters":2,"animationClips":3,"avatarUnsupported":4},"Luna.Unity.DTO.UnityEngine.Animation.Mecanim.AnimatorControllerLayer":{"name":0,"defaultWeight":1,"blendingMode":2,"avatarMask":3,"syncedLayerIndex":4,"syncedLayerAffectsTiming":5,"syncedLayers":6,"stateMachine":7},"Luna.Unity.DTO.UnityEngine.Animation.Mecanim.AnimatorStateMachine":{"id":0,"name":1,"path":2,"states":3,"machines":4,"entryStateTransitions":5,"exitStateTransitions":6,"anyStateTransitions":7,"defaultStateId":8},"Luna.Unity.DTO.UnityEngine.Animation.Mecanim.AnimatorState":{"id":0,"name":1,"cycleOffset":2,"cycleOffsetParameter":3,"cycleOffsetParameterActive":4,"mirror":5,"mirrorParameter":6,"mirrorParameterActive":7,"motionId":8,"nameHash":9,"fullPathHash":10,"speed":11,"speedParameter":12,"speedParameterActive":13,"tag":14,"tagHash":15,"writeDefaultValues":16,"behaviours":17,"transitions":18},"Luna.Unity.DTO.UnityEngine.Animation.Mecanim.AnimatorStateTransition":{"fullPath":0,"canTransitionToSelf":1,"duration":2,"exitTime":3,"hasExitTime":4,"hasFixedDuration":5,"interruptionSource":6,"offset":7,"orderedInterruption":8,"destinationStateId":9,"isExit":10,"mute":11,"solo":12,"conditions":13},"Luna.Unity.DTO.UnityEngine.Animation.Mecanim.AnimatorTransition":{"destinationStateId":0,"isExit":1,"mute":2,"solo":3,"conditions":4},"Luna.Unity.DTO.UnityEngine.Animation.Mecanim.AnimatorControllerParameter":{"defaultBool":0,"defaultFloat":1,"defaultInt":2,"name":3,"nameHash":4,"type":5},"Luna.Unity.DTO.UnityEngine.Assets.TextAsset":{"name":0,"bytes64":1,"data":2},"Luna.Unity.DTO.UnityEngine.Assets.Resources":{"files":0,"componentToPrefabIds":1},"Luna.Unity.DTO.UnityEngine.Assets.Resources+File":{"path":0,"unityObject":1},"Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings":{"scriptsExecutionOrder":0,"sortingLayers":1,"cullingLayers":2,"timeSettings":3,"physicsSettings":4,"physics2DSettings":5,"qualitySettings":6,"enableRealtimeShadows":7,"enableAutoInstancing":8,"enableStaticBatching":9,"enableDynamicBatching":10,"lightmapEncodingQuality":11,"desiredColorSpace":12,"allTags":13},"Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+ScriptsExecutionOrder":{"name":0,"value":1},"Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+SortingLayer":{"id":0,"name":1,"value":2},"Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+CullingLayer":{"id":0,"name":1},"Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+TimeSettings":{"fixedDeltaTime":0,"maximumDeltaTime":1,"timeScale":2,"maximumParticleTimestep":3},"Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+PhysicsSettings":{"gravity":0,"defaultSolverIterations":3,"bounceThreshold":4,"autoSyncTransforms":5,"autoSimulation":6,"collisionMatrix":7},"Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+PhysicsSettings+CollisionMask":{"enabled":0,"layerId":1,"otherLayerId":2},"Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+Physics2DSettings":{"material":0,"gravity":2,"positionIterations":4,"velocityIterations":5,"velocityThreshold":6,"maxLinearCorrection":7,"maxAngularCorrection":8,"maxTranslationSpeed":9,"maxRotationSpeed":10,"baumgarteScale":11,"baumgarteTOIScale":12,"timeToSleep":13,"linearSleepTolerance":14,"angularSleepTolerance":15,"defaultContactOffset":16,"autoSimulation":17,"queriesHitTriggers":18,"queriesStartInColliders":19,"callbacksOnDisable":20,"reuseCollisionCallbacks":21,"autoSyncTransforms":22,"collisionMatrix":23},"Luna.Unity.DTO.UnityEngine.Assets.ProjectSettings+Physics2DSettings+CollisionMask":{"enabled":0,"layerId":1,"otherLayerId":2},"Luna.Unity.DTO.UnityEngine.Assets.QualitySettings":{"qualityLevels":0,"names":1,"shadows":2,"anisotropicFiltering":3,"antiAliasing":4,"lodBias":5,"shadowCascades":6,"shadowDistance":7,"shadowmaskMode":8,"shadowProjection":9,"shadowResolution":10,"softParticles":11,"softVegetation":12,"activeColorSpace":13,"desiredColorSpace":14,"masterTextureLimit":15,"maxQueuedFrames":16,"particleRaycastBudget":17,"pixelLightCount":18,"realtimeReflectionProbes":19,"shadowCascade2Split":20,"shadowCascade4Split":21,"streamingMipmapsActive":24,"vSyncCount":25,"asyncUploadBufferSize":26,"asyncUploadTimeSlice":27,"billboardsFaceCameraPosition":28,"shadowNearPlaneOffset":29,"streamingMipmapsMemoryBudget":30,"maximumLODLevel":31,"streamingMipmapsAddAllCameras":32,"streamingMipmapsMaxLevelReduction":33,"streamingMipmapsRenderersPerFrame":34,"resolutionScalingFixedDPIFactor":35,"streamingMipmapsMaxFileIORequests":36,"currentQualityLevel":37},"Luna.Unity.DTO.UnityEngine.Assets.Mesh+BlendShapeFrame":{"weight":0,"vertices":1,"normals":2,"tangents":3},"Luna.Unity.DTO.UnityEngine.Animation.Mecanim.AnimatorCondition":{"mode":0,"parameter":1,"threshold":2}}

Deserializers.requiredComponents = {"20":[21],"22":[21],"23":[21],"24":[21],"25":[21],"26":[21],"27":[28],"29":[2],"30":[31],"32":[31],"33":[31],"34":[31],"35":[31],"36":[31],"37":[31],"38":[39],"40":[39],"41":[39],"42":[39],"43":[39],"44":[39],"45":[39],"46":[39],"47":[39],"48":[39],"49":[39],"50":[39],"51":[39],"52":[2],"53":[9],"54":[55],"56":[55],"57":[58],"59":[58],"60":[2],"61":[2],"5":[3],"62":[63],"64":[58],"65":[58],"66":[57],"67":[68,58],"69":[58],"70":[57],"71":[58],"72":[58],"73":[58],"74":[58],"75":[58],"76":[58],"77":[58],"78":[58],"79":[58],"80":[68,58],"81":[58],"82":[58],"83":[58],"84":[58],"85":[68,58],"86":[58],"87":[88],"89":[88],"90":[88],"91":[88],"92":[2],"93":[2],"94":[63],"95":[58],"96":[9,58],"97":[58,68],"98":[58],"99":[68,58],"100":[9],"101":[68,58],"102":[58],"103":[63]}

Deserializers.types = ["UnityEngine.Shader","UnityEngine.Transform","UnityEngine.Camera","UnityEngine.Light","UnityEngine.MonoBehaviour","UnityEngine.Rendering.Universal.UniversalAdditionalLightData","StateManager","UnityEngine.MeshFilter","UnityEngine.Mesh","UnityEngine.MeshRenderer","UnityEngine.Material","UnityEngine.Cubemap","UnityEngine.Texture2D","DG.Tweening.Core.DOTweenSettings","TMPro.TMP_Settings","TMPro.TMP_FontAsset","TMPro.TMP_SpriteAsset","TMPro.TMP_StyleSheet","UnityEngine.TextAsset","UnityEngine.Font","UnityEngine.AudioLowPassFilter","UnityEngine.AudioBehaviour","UnityEngine.AudioHighPassFilter","UnityEngine.AudioReverbFilter","UnityEngine.AudioDistortionFilter","UnityEngine.AudioEchoFilter","UnityEngine.AudioChorusFilter","UnityEngine.Cloth","UnityEngine.SkinnedMeshRenderer","UnityEngine.FlareLayer","UnityEngine.ConstantForce","UnityEngine.Rigidbody","UnityEngine.Joint","UnityEngine.HingeJoint","UnityEngine.SpringJoint","UnityEngine.FixedJoint","UnityEngine.CharacterJoint","UnityEngine.ConfigurableJoint","UnityEngine.CompositeCollider2D","UnityEngine.Rigidbody2D","UnityEngine.Joint2D","UnityEngine.AnchoredJoint2D","UnityEngine.SpringJoint2D","UnityEngine.DistanceJoint2D","UnityEngine.FrictionJoint2D","UnityEngine.HingeJoint2D","UnityEngine.RelativeJoint2D","UnityEngine.SliderJoint2D","UnityEngine.TargetJoint2D","UnityEngine.FixedJoint2D","UnityEngine.WheelJoint2D","UnityEngine.ConstantForce2D","UnityEngine.StreamingController","UnityEngine.TextMesh","UnityEngine.Tilemaps.TilemapRenderer","UnityEngine.Tilemaps.Tilemap","UnityEngine.Tilemaps.TilemapCollider2D","UnityEngine.Canvas","UnityEngine.RectTransform","UnityEngine.Rendering.UI.UIFoldout","UnityEngine.Experimental.Rendering.Universal.PixelPerfectCamera","UnityEngine.Rendering.Universal.UniversalAdditionalCameraData","Unity.VisualScripting.SceneVariables","Unity.VisualScripting.Variables","UnityEngine.UI.Dropdown","UnityEngine.UI.Graphic","UnityEngine.UI.GraphicRaycaster","UnityEngine.UI.Image","UnityEngine.CanvasRenderer","UnityEngine.UI.AspectRatioFitter","UnityEngine.UI.CanvasScaler","UnityEngine.UI.ContentSizeFitter","UnityEngine.UI.GridLayoutGroup","UnityEngine.UI.HorizontalLayoutGroup","UnityEngine.UI.HorizontalOrVerticalLayoutGroup","UnityEngine.UI.LayoutElement","UnityEngine.UI.LayoutGroup","UnityEngine.UI.VerticalLayoutGroup","UnityEngine.UI.Mask","UnityEngine.UI.MaskableGraphic","UnityEngine.UI.RawImage","UnityEngine.UI.RectMask2D","UnityEngine.UI.Scrollbar","UnityEngine.UI.ScrollRect","UnityEngine.UI.Slider","UnityEngine.UI.Text","UnityEngine.UI.Toggle","UnityEngine.EventSystems.BaseInputModule","UnityEngine.EventSystems.EventSystem","UnityEngine.EventSystems.PointerInputModule","UnityEngine.EventSystems.StandaloneInputModule","UnityEngine.EventSystems.TouchInputModule","UnityEngine.EventSystems.Physics2DRaycaster","UnityEngine.EventSystems.PhysicsRaycaster","Unity.VisualScripting.ScriptMachine","TMPro.TextContainer","TMPro.TextMeshPro","TMPro.TextMeshProUGUI","TMPro.TMP_Dropdown","TMPro.TMP_SelectionCaret","TMPro.TMP_SubMesh","TMPro.TMP_SubMeshUI","TMPro.TMP_Text","Unity.VisualScripting.StateMachine"]

Deserializers.unityVersion = "2022.3.14f1c1";

Deserializers.productName = "Client";

Deserializers.lunaInitializationTime = "02/17/2026 07:58:25";

Deserializers.lunaDaysRunning = "24.2";

Deserializers.lunaVersion = "6.4.0";

Deserializers.lunaSHA = "6639120529aa36186c6141b5c3fb20246c28bff0";

Deserializers.creativeName = "";

Deserializers.lunaAppID = "0";

Deserializers.projectId = "181ed7a210daeef4d938a69d80605319";

Deserializers.packagesInfo = "com.unity.render-pipelines.universal: 14.0.9\ncom.unity.textmeshpro: 3.0.6\ncom.unity.timeline: 1.7.6\ncom.unity.ugui: 1.0.0";

Deserializers.externalJsLibraries = "";

Deserializers.androidLink = ( typeof window !== "undefined")&&window.$environment.packageConfig.androidLink?window.$environment.packageConfig.androidLink:'Empty';

Deserializers.iosLink = ( typeof window !== "undefined")&&window.$environment.packageConfig.iosLink?window.$environment.packageConfig.iosLink:'Empty';

Deserializers.base64Enabled = "False";

Deserializers.minifyEnabled = "True";

Deserializers.isForceUncompressed = "False";

Deserializers.isAntiAliasingEnabled = "False";

Deserializers.isRuntimeAnalysisEnabledForCode = "False";

Deserializers.runtimeAnalysisExcludedClassesCount = "0";

Deserializers.runtimeAnalysisExcludedMethodsCount = "0";

Deserializers.runtimeAnalysisExcludedModules = "";

Deserializers.isRuntimeAnalysisEnabledForShaders = "True";

Deserializers.isRealtimeShadowsEnabled = "False";

Deserializers.isReferenceAmbientProbeBaked = "False";

Deserializers.isLunaCompilerV2Used = "False";

Deserializers.companyName = "DefaultCompany";

Deserializers.buildPlatform = "StandaloneWindows64";

Deserializers.applicationIdentifier = "com.Unity-Technologies.com.unity.template.urp-blank";

Deserializers.disableAntiAliasing = true;

Deserializers.graphicsConstraint = 28;

Deserializers.linearColorSpace = true;

Deserializers.buildID = "942af5e8-fa2c-41d6-8bfc-6fa287901891";

Deserializers.runtimeInitializeOnLoadInfos = [[["UnityEngine","Rendering","DebugUpdater","RuntimeInit"],["UnityEngine","Experimental","Rendering","ScriptableRuntimeReflectionSystemSettings","ScriptingDirtyReflectionSystemInstance"]],[["Sirenix","Utilities","UnityVersion","EnsureLoaded"],["Sirenix","Serialization","Utilities","UnityVersion","EnsureLoaded"],["Sirenix","Serialization","UnitySerializationInitializer","InitializeRuntime"],["Unity","VisualScripting","RuntimeVSUsageUtility","RuntimeInitializeOnLoadBeforeSceneLoad"]],[],[["UnityEngine","Experimental","Rendering","XRSystem","XRSystemInit"]],[]];

Deserializers.typeNameToIdMap = function(){ var i = 0; return Deserializers.types.reduce( function( res, item ) { res[ item ] = i++; return res; }, {} ) }()

